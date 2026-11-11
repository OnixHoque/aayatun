/*
 * Sharing for Aayatun's reading views.
 *
 * One module builds the social-media text for every view (verse, whole surah,
 * printed mushaf page), calls the Web Share API when available, and falls back
 * to copying the formatted text.
 *
 * The verse page, the arabic surah view, the translation view and the mushaf
 * page also get a PNG card, drawn on a canvas instead of screenshotted: the
 * reference in Merriweather at the top, then the plain Uthmani Arabic (never
 * the tajweed/QCF glyphs) with its translation in smaller text underneath.
 * The verse page shows the one verse; the whole-surah and page views show the
 * first five verses (or the whole surah when it is shorter) as one Arabic
 * paragraph with an end-of-ayah medallion after each verse, then all their
 * translations grouped underneath with the same medallions. Both faces shrink
 * until the body fits the card. The site name and the full URL sit in a small
 * band at the bottom. No buttons, legends or credits, and nothing depends on
 * what happens to be scrolled into view.
 *
 * The index's Quran Exploration Map gets its own card, a 9:16 poster: the
 * reader's own dated line, two large circular progress rings that carry both
 * counts under them, the map as one rectangular bitmap that spans the card, a
 * two-row key, and the brand band.
 *
 * Drawing is synchronous, so the file can be produced inside the tap: Safari
 * requires navigator.share() to run within the user gesture, and a canvas
 * costs a few milliseconds where html2canvas cost a few hundred. Where the
 * browser cannot attach files, the text is shared (or copied) instead.
 *
 * Tafsir views are text-only.
 */
(function () {
	'use strict';

	var HASHTAG = '#aayatun';
	// Cards are laid out in a friendly 420 px column and rendered at 1080 px
	// wide, the size every share sheet and feed expects, so nothing is
	// upscaled by the receiving app.
	var OUTPUT_W = 1080;      // output pixels wide
	var CARD_W = 420;         // CSS px wide card
	var PAD = 26;             // CSS px card padding
	var BAND = 64;            // CSS px of branding band
	var MIN_BODY = 316;       // a short verse still fills a square card

	var TITLE = { weight: 700, family: 'Merriweather, Georgia, serif', size: 27, line: 1.3 };
	var SUB = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 14, line: 1.5 };
	var ARABIC = { weight: 700, family: 'Scheherazade, serif', size: 38, line: 1.75 };
	var TRANS = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 17, line: 1.55 };
	// Multi-verse cards carry five verses, so they start a little smaller and
	// shrink (down to the minimums) until the body fits MAX_BODY.
	var M_ARABIC = { weight: 700, family: 'Scheherazade, serif', size: 31, line: 1.7 };
	var M_TRANS = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 15, line: 1.5 };
	var M_MIN_ARABIC = 21;
	var M_MIN_TRANS = 12;
	var MAX_BODY = 1320;      // CSS px of text before the fit pass shrinks it

	var VIEW_LABEL = {
		arabic: 'Arabic text with translation',
		translation: 'English translation',
		'tafsir-en': "Ibn Kathir's tafsir",
		'tafsir-bn': 'Bangla tafsir (Abu Bakr Zakaria)'
	};

	// Quran exploration map card: a story-sized 9:16 poster (460 x 818 CSS
	// px). The map is a 10:5 rectangle that spans the card (84 x 42 cells at
	// 5 CSS px), rendered as one bitmap rather than one rect per verse, so it
	// always fits the canvas exactly. 6,236 verses are subsampled into those
	// 3,528 cells: a cell takes the strongest state of the verses that land
	// in it, deepest green beating light green.
	var MAP_W = 460;
	var MAP_CARD_H = 818;
	var MAP_COLS = 84;
	var MAP_ROWS = 42;
	var MAP_CELL = 5;
	var MAP_VERSES = 6236;
	var MAP_PAGES = 604;

	var TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

	function byId(id) { return document.getElementById(id); }
	function noop() {}
	function fontFor(spec, size) {
		return spec.weight + ' ' + size + 'px ' + spec.family;
	}
	function shortName(name) {
		return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
	}
	function isDark() {
		return document.documentElement.classList.contains('dark-theme');
	}
	function pageUrl(path) { return new URL(path, window.location.origin).href; }

	function pctLabel(p) {
		if (!p) return '0%';
		if (p >= 99.95) return '100%';
		if (p < 1) return p.toFixed(2) + '%';
		if (p < 10) return p.toFixed(1) + '%';
		return Math.round(p) + '%';
	}

	function verseText(o) {
		return shortName(o.name) + ' ' + o.surah + ':' + o.verse + '\n\n' +
			(o.translation || '').trim() + '\n\nRead on Aayatun: ' + o.url +
			'\n' + HASHTAG;
	}

	function surahText(o) {
		return 'Surah ' + shortName(o.name) + ' (' + o.surah + ') — ' +
			(VIEW_LABEL[o.view] || 'the Quran') + ' on Aayatun.\n\n' + o.url +
			'\n' + HASHTAG;
	}

	function pageText(o) {
		return 'Mushaf page ' + o.page +
			(o.range ? ' — ' + o.range : '') +
			'\n\nRead on Aayatun: ' + o.url + '\n' + HASHTAG;
	}

	function parseVerses(raw) {
		if (!raw) return null;
		try {
			var rows = JSON.parse(raw);
			return (rows && rows.length) ? rows : null;
		} catch (e) {
			return null;
		}
	}

	/* ------------------------------------------------------------- payloads */

	function versePayload(v) {
		var url = pageUrl('/' + v.surah + '/' + v.verse);
		return {
			kind: 'verse',
			card: 'verse',
			ref: 'ayah-' + v.surah + '-' + v.verse,
			title: 'Aayatun — ' + shortName(v.name) + ' ' + v.surah + ':' + v.verse,
			text: verseText({
				name: v.name, surah: v.surah, verse: v.verse,
				translation: v.translation, url: url
			}),
			url: url,
			surah: v.surah, verse: v.verse, name: v.name,
			// Plain Uthmani text: with tajweed on, the h1 holds QCF codepoints.
			ayah: v.ayah || '',
			translation: v.translation || ''
		};
	}

	function payloadFromButton(btn) {
		var d = btn.dataset || {};
		var kind = d.shareKind;
		if (!kind) return null;
		var payload = {
			kind: kind,
			url: d.shareUrl || window.location.href,
			ref: d.shareRef || kind
		};
		// [surah, verse, arabic, translation] rows for the image, rendered by
		// the server because /translation paginates its table and its rows
		// carry no Arabic.
		var verses = parseVerses(d.shareCard);
		if (verses) payload.verses = verses;
		if (d.shareMore === '1') payload.more = true;
		if (kind === 'surah') {
			payload.title = 'Aayatun — Surah ' + shortName(d.name);
			payload.text = surahText({
				name: d.name, surah: d.surah, view: d.view, url: payload.url
			});
			payload.surah = d.surah;
			payload.name = d.name;
			if (verses && (d.view === 'arabic' || d.view === 'translation')) {
				payload.card = d.view;
			}
		} else if (kind === 'page') {
			payload.title = 'Aayatun — Mushaf page ' + d.page;
			payload.text = pageText({
				page: d.page, range: d.range, url: payload.url
			});
			payload.page = d.page;
			payload.range = d.range || '';
			payload.card = 'page';
		} else if (kind === 'verse') {
			payload.title = d.shareTitle || 'Aayatun';
			payload.text = d.shareText || '';
			payload.url = d.shareUrl || window.location.href;
		} else {
			return null;
		}
		return payload;
	}

	/* ---------------------------------------------------------------- files */

	var canShareProbe = null;

	function canShareFiles() {
		if (canShareProbe !== null) return canShareProbe;
		try {
			if (!navigator.canShare || !window.File || !window.Blob) {
				canShareProbe = false;
			} else {
				var bytes = atob(TINY_PNG);
				var arr = new Uint8Array(bytes.length);
				for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
				var probe = new File([arr], 'probe.png', { type: 'image/png' });
				canShareProbe = navigator.canShare({ files: [probe] });
			}
		} catch (e) {
			canShareProbe = false;
		}
		return canShareProbe;
	}

	// The card is drawn on a canvas, so the webfonts must already be in the
	// document's font set or the text silently falls back. With tajweed
	// persisted ON the plain Arabic is never painted, so Scheherazade may not
	// have been fetched at all — ask for all three faces once at load. The
	// Arabic sample matters: Google Fonts ships Scheherazade as unicode-range
	// subsets and a bare load() only pulls the Latin one, which left the
	// translation card (no Arabic on the page) drawing tofu boxes.
	var ARABIC_SAMPLE = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';

	function warmFonts() {
		if (!document.fonts || !document.fonts.load) return;
		var faces = [
			fontFor(TITLE, TITLE.size),
			fontFor(ARABIC, ARABIC.size),
			fontFor(TRANS, TRANS.size)
		];
		for (var i = 0; i < faces.length; i++) {
			try {
				document.fonts.load(faces[i], ARABIC_SAMPLE).catch(noop);
			} catch (e) {}
		}
	}

	/* ----------------------------------------------------------- the card */

	// The first verse of the current view: the mushaf table's first row, or
	// the arabic surah view's first .mushaf-ayah. The plain span is always in
	// the DOM (even with the coloured font on, and in the line layout).
	function firstVerseText() {
		var el = document.querySelector('#mushaf-page-table .mushaf-row .mushaf-plain') ||
			document.querySelector('.mushaf-ayah .mushaf-plain');
		return el ? (el.textContent || '').trim() : '';
	}

	function cardFor(payload) {
		if (!payload || !payload.card) return null;
		var card = { url: payload.url, ref: payload.ref };

		if (payload.card === 'verse') {
			card.title = shortName(payload.name) + ' ' +
				payload.surah + ':' + payload.verse;
			card.arabic = payload.ayah;
			card.translation = payload.translation;
		} else if (payload.card === 'arabic' || payload.card === 'translation') {
			card.title = shortName(payload.name) + ' (' + payload.surah + ')';
			card.subtitle = VIEW_LABEL[payload.card] || '';
			card.verses = payload.verses;
			card.more = !!payload.more;
			// The translation view is a translation card: its Arabic paragraph
			// would double the card and say nothing the English does not.
			card.skipArabic = payload.card === 'translation';
			if (!card.verses && !card.skipArabic) card.arabic = firstVerseText();
		} else if (payload.card === 'page') {
			card.title = 'Mushaf page ' + payload.page;
			card.subtitle = payload.range || '';
			card.verses = payload.verses;
			card.more = !!payload.more;
			if (!card.verses) card.arabic = firstVerseText();
		} else if (payload.card === 'map') {
			card.kind = 'map';
			card.states = payload.states;
			card.deep = payload.deep || 0;
			card.pages = payload.pages || 0;
			card.starts = payload.starts || [];
			card.message = mapMessage();
			return card;
		} else {
			return null;
		}

		if (!card.arabic && !(card.verses && card.verses.length)) return null;
		return card;
	}

	// Greedy word wrap. Arabic words are space-separated too, and measureText
	// respects the current ctx.direction, so one helper covers both scripts.
	function wrap(ctx, text, maxW) {
		var clean = String(text || '').replace(/\s+/g, ' ').trim();
		if (!clean) return [];
		var words = clean.split(' ');
		var lines = [];
		var line = '';
		for (var i = 0; i < words.length; i++) {
			var next = line ? line + ' ' + words[i] : words[i];
			// An end-of-ayah medallion must never start a line: keep it on
			// the verse's last line even if it spills a few pixels into the
			// card padding (the extra width is at most one medallion).
			if (!line || ctx.measureText(next).width <= maxW ||
				words[i].charAt(0) === '\u06DD') {
				line = next;
			} else {
				lines.push(line);
				line = words[i];
			}
		}
		if (line) lines.push(line);
		return lines;
	}

	function linesFor(ctx, text, spec, size, maxW, rtl) {
		ctx.direction = rtl ? 'rtl' : 'ltr';
		ctx.font = fontFor(spec, size);
		var lines = wrap(ctx, text, maxW);
		ctx.direction = 'ltr';
		return lines;
	}

	var ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

	// U+06DD is the ornate end-of-ayah medallion; the digits after it are
	// drawn inside it by Scheherazade, which is the "dot" the card uses to
	// pair each Arabic verse with its translation.
	function verseMarker(verse) {
		return '\u06DD' + String(verse).replace(/[0-9]/g, function (d) {
			return ARABIC_DIGITS.charAt(+d);
		});
	}

	// Multi-verse body: all the Arabic verses as one flowing paragraph with
	// the medallion after each, then all the translations as a second
	// paragraph underneath, with the same medallions inline. A trailing
	// ellipsis on both paragraphs says the view has more verses than fit.
	// Translation cards pass skipArabic: only the translation paragraph (and
	// its medallions) is measured and drawn. Measured at one size pair so the
	// fit pass can shrink both faces.
	function measureBody(ctx, verses, aSize, tSize, maxW, more, skipArabic) {
		var arabic = [];
		if (!skipArabic) {
			var arabicText = '';
			for (var i = 0; i < verses.length; i++) {
				var part = String(verses[i][2] || '').trim() + ' ' +
					verseMarker(verses[i][1]);
				arabicText += arabicText ? ' ' + part : part;
			}
			if (more) arabicText += ' …';
			arabic = linesFor(ctx, arabicText, M_ARABIC, aSize, maxW, true);
			// Keep the truncation mark on the final line instead of letting it
			// sit alone on a new one; the small overhang is the same allowance
			// the medallion gets.
			if (more && arabic.length > 1 &&
				arabic[arabic.length - 1] === '…') {
				arabic[arabic.length - 2] += ' …';
				arabic.pop();
			}
		}

		var markerSize = Math.max(12, tSize * 1.5);
		var tokens = [];
		ctx.font = fontFor(M_TRANS, tSize);
		var spaceW = ctx.measureText(' ').width;
		function textTokens(text) {
			var words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
			var out = [];
			for (var w = 0; w < words.length; w++) {
				if (!words[w]) continue;
				out.push({ marker: false, text: words[w],
					width: ctx.measureText(words[w]).width });
			}
			return out;
		}
		for (var j = 0; j < verses.length; j++) {
			ctx.font = fontFor(M_TRANS, tSize);
			var words = textTokens(verses[j][3]);
			for (var k = 0; k < words.length; k++) tokens.push(words[k]);
			var marker = verseMarker(verses[j][1]);
			ctx.font = fontFor(M_ARABIC, markerSize);
			tokens.push({ marker: true, text: marker,
				width: ctx.measureText(marker).width, size: markerSize });
		}
		if (more) {
			ctx.font = fontFor(M_TRANS, tSize);
			tokens.push({ marker: false, text: '…',
				width: ctx.measureText('…').width });
		}

		// Greedy wrap over words and medallions. A medallion never starts a
		// line: it may overhang the last line by its own width instead.
		var lines = [];
		var cur = [];
		var curW = 0;
		for (var t = 0; t < tokens.length; t++) {
			var tok = tokens[t];
			var add = cur.length ? spaceW + tok.width : tok.width;
			if (cur.length && curW + add > maxW &&
				!tok.marker && tok.text !== '…') {
				lines.push({ tokens: cur, width: curW });
				cur = [];
				curW = 0;
				add = tok.width;
			}
			cur.push(tok);
			curW += add;
		}
		if (cur.length) lines.push({ tokens: cur, width: curW });

		var arabicH = skipArabic ? 0 : arabic.length * aSize * M_ARABIC.line;
		var transH = lines.length * tSize * M_TRANS.line;
		return {
			arabic: arabic, trans: lines, spaceW: spaceW,
			markerSize: markerSize, skipArabic: !!skipArabic,
			height: arabicH +
				(lines.length ? (skipArabic ? 0 : 22) + transH : 0)
		};
	}

	function drawMapCard(card) {
		var dark = isDark();
		var states = card.states && card.states.length === MAP_VERSES
			? card.states : new Uint8Array(MAP_VERSES);

		var cells = MAP_COLS * MAP_ROWS;
		var mapW = MAP_COLS * MAP_CELL;
		var mapH = MAP_ROWS * MAP_CELL;

		// A story-sized poster: the reader's own line, the two rings, the
		// map, its key and the tag, all inside one 9:16 frame. The rings
		// already spell out both counts, so there is no extra counts line.
		var cardH = MAP_CARD_H;
		var titleY = 82;
		var msgY = 122;
		var ringsY = 254;
		var mapTop = 376;
		var legendY = 616;
		var tagY = 686;

		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(cardH * (OUTPUT_W / MAP_W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / MAP_W, OUTPUT_W / MAP_W);
		ctx.textBaseline = 'middle';

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, MAP_W, cardH);

		var titleColor = dark ? '#9CC4FF' : '#4183C4';
		var muted = dark ? 'rgba(255,255,255,.56)' : 'rgba(0,0,0,.5)';
		var track = dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.07)';
		var none = dark ? [42, 47, 54] : [230, 233, 236];
		var light = dark ? [14, 68, 41] : [155, 233, 168];
		var deep1 = dark ? [0, 109, 50] : [64, 196, 99];
		var deep2 = dark ? [38, 166, 65] : [48, 161, 78];
		var deep3 = dark ? [57, 211, 83] : [33, 110, 57];
		var shades = [none, light, deep1, deep2, deep3];
		var ringLight = dark ? '#2ea043' : '#9be9a8';
		var ringDeep = dark ? '#39d353' : '#216e39';

		ctx.textAlign = 'center';
		ctx.fillStyle = titleColor;
		ctx.font = fontFor(TITLE, 28);
		ctx.fillText('Quran Exploration Map', MAP_W / 2, titleY);

		ctx.fillStyle = dark ? 'rgba(255,255,255,.74)' : 'rgba(0,0,0,.64)';
		ctx.font = "400 17px 'Open Sans', system-ui, sans-serif";
		var msgLines = wrap(ctx, card.message || mapMessage(), MAP_W - PAD * 2);
		for (var m = 0; m < msgLines.length; m++) {
			ctx.fillText(msgLines[m], MAP_W / 2, msgY + m * 24);
		}

		var pagesPct = (card.pages / MAP_PAGES) * 100;
		var versesPct = (card.deep / MAP_VERSES) * 100;

		// The rings are the card's headline: a percentage inside, and the
		// label and count centred underneath, so both stats read at a glance
		// without repeating them again at the bottom of the poster.
		function ringStat(cx, pct, color, label, note) {
			var r = 46;
			ctx.lineWidth = 12;
			ctx.lineCap = 'butt';
			ctx.beginPath();
			ctx.arc(cx, ringsY, r, 0, Math.PI * 2);
			ctx.strokeStyle = track;
			ctx.stroke();
			if (pct > 0) {
				ctx.beginPath();
				ctx.arc(cx, ringsY, r, -Math.PI / 2,
					-Math.PI / 2 + Math.PI * 2 * Math.min(1, pct / 100));
				ctx.lineCap = 'round';
				ctx.strokeStyle = color;
				ctx.stroke();
			}
			ctx.lineCap = 'butt';
			ctx.textAlign = 'center';
			ctx.fillStyle = dark ? 'rgba(255,255,255,.94)' : 'rgba(0,0,0,.85)';
			ctx.font = "700 25px 'Open Sans', system-ui, sans-serif";
			ctx.fillText(pctLabel(pct), cx, ringsY + 1);

			ctx.fillStyle = dark ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.8)';
			ctx.font = "600 17px 'Open Sans', system-ui, sans-serif";
			ctx.fillText(label, cx, ringsY + r + 30);
			ctx.fillStyle = muted;
			ctx.font = "400 14px 'Open Sans', system-ui, sans-serif";
			ctx.fillText(note, cx, ringsY + r + 52);
		}

		var ringGap = 100;
		ringStat(MAP_W / 2 - ringGap, pagesPct, ringLight,
			'Pages visited', card.pages + ' of 604');
		ringStat(MAP_W / 2 + ringGap, versesPct, ringDeep,
			'Verses studied', card.deep.toLocaleString() + ' of 6,236');

		// Subsampling: every verse lands in a cell, and a cell takes the
		// strongest state found there (deep beats light). One bitmap pixel
		// per card pixel, with a 1 px gap left inside each cell, so the map
		// is a field of dots the way the in-app grid is, not a solid sheet.
		var RES = MAP_CELL;
		var bmp = document.createElement('canvas');
		bmp.width = MAP_COLS * RES;
		bmp.height = MAP_ROWS * RES;
		var bctx = bmp.getContext('2d');
		var img = bctx.createImageData(bmp.width, bmp.height);
		var px = img.data;
		var cardBg = dark ? [27, 28, 29] : [255, 255, 255];

		for (var b = 0; b < img.data.length; b += 4) {
			px[b] = cardBg[0];
			px[b + 1] = cardBg[1];
			px[b + 2] = cardBg[2];
			px[b + 3] = 255;
		}

		var cellState = new Uint8Array(cells);
		for (var v = 0; v < MAP_VERSES; v++) {
			var state = states[v];
			if (!state) continue;
			var cell = Math.floor(v * cells / MAP_VERSES);
			if (state > cellState[cell]) cellState[cell] = state;
		}
		var dot = RES - 1;
		for (var c = 0; c < cells; c++) {
			var rgb = shades[cellState[c]];
			// Column-major, so the card reads across exactly like the popup.
			var row = c % MAP_ROWS;
			var col = (c - row) / MAP_ROWS;
			var x = col * RES;
			var y = row * RES;
			for (var dy = 0; dy < dot; dy++) {
				var o = ((y + dy) * bmp.width + x) * 4;
				for (var dx = 0; dx < dot; dx++) {
					px[o] = rgb[0];
					px[o + 1] = rgb[1];
					px[o + 2] = rgb[2];
					o += 4;
				}
			}
		}
		bctx.putImageData(img, 0, 0);

		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(bmp, (MAP_W - mapW) / 2, mapTop, mapW, mapH);
		ctx.imageSmoothingEnabled = true;

		// The key spells the shades out in two rows: the two page-level
		// colours first, then the three verse-frequency greens with their
		// multipliers, so nobody has to guess what "Less/More" means.
		var sw = 15, gap = 7, groupGap = 30;
		var legendFont = "400 17px 'Open Sans', system-ui, sans-serif";
		ctx.font = legendFont;
		ctx.textAlign = 'left';

		function keySwatch(x, y, rgb) {
			ctx.fillStyle = 'rgb(' + rgb.join(',') + ')';
			ctx.fillRect(x, y - sw / 2, sw, sw);
		}
		function keyWord(x, y, text) {
			ctx.fillStyle = dark ? 'rgba(255,255,255,.72)' : 'rgba(0,0,0,.62)';
			ctx.fillText(text, x, y);
			return x + ctx.measureText(text).width;
		}

		var wNot = ctx.measureText('Not yet').width;
		var wPage = ctx.measureText('Page visited').width;
		var row1W = sw + gap + wNot + groupGap + sw + gap + wPage;
		var lx = (MAP_W - row1W) / 2;
		keySwatch(lx, legendY, shades[0]);
		lx = keyWord(lx + sw + gap, legendY + 1, 'Not yet') + groupGap;
		keySwatch(lx, legendY, shades[1]);
		keyWord(lx + sw + gap, legendY + 1, 'Page visited');

		var prefix = 'Verses opened: ';
		var wOne = ctx.measureText('1×').width;
		var wTwo = ctx.measureText('2×').width;
		var wThree = ctx.measureText('3×+').width;
		var row2W = ctx.measureText(prefix).width + sw + gap + wOne +
			groupGap + sw + gap + wTwo + groupGap + sw + gap + wThree;
		var lx2 = (MAP_W - row2W) / 2;
		var y2 = legendY + 33;
		lx2 = keyWord(lx2, y2, prefix);
		keySwatch(lx2, y2 - 1, shades[2]);
		lx2 = keyWord(lx2 + sw + gap, y2, '1×') + groupGap;
		keySwatch(lx2, y2 - 1, shades[3]);
		lx2 = keyWord(lx2 + sw + gap, y2, '2×') + groupGap;
		keySwatch(lx2, y2 - 1, shades[4]);
		keyWord(lx2 + sw + gap, y2, '3×+');

		ctx.textAlign = 'center';
		ctx.fillStyle = muted;
		ctx.font = "400 15px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('#aayatun', MAP_W / 2, tagY);

		/* Brand band: the site name, then the full URL under it. */
		var bandTop = cardH - BAND;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
		ctx.fillRect(0, bandTop, MAP_W, BAND);

		ctx.textAlign = 'center';
		ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
		ctx.font = "600 16px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', MAP_W / 2, bandTop + BAND * 0.36);

		var label = String(card.url || '');
		var size = 12;
		var bandMax = MAP_W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > bandMax && size > 9) {
			size -= 0.5;
			ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		}
		ctx.fillText(label, MAP_W / 2, bandTop + BAND * 0.72);

		return out;
	}

	function drawCard(card) {
		if (card.kind === 'map') return drawMapCard(card);
		var maxW = CARD_W - PAD * 2;
		var dark = isDark();

		// Measure first (off-screen), then size the real canvas.
		var meter = document.createElement('canvas').getContext('2d');
		var titleLines = linesFor(meter, card.title, TITLE, TITLE.size, maxW, false);
		var subLines = card.subtitle
			? linesFor(meter, card.subtitle, SUB, SUB.size, maxW, false) : [];
		var titleH = titleLines.length * TITLE.size * TITLE.line;
		// +8 covers the 4 px gap above and below the subtitle when drawn.
		var subH = subLines.length ? subLines.length * SUB.size * SUB.line + 8 : 0;

		var verses = card.verses && card.verses.length ? card.verses : null;
		var arabicLines = null, transLines = null, bodyH;
		var aSize = M_ARABIC.size, tSize = M_TRANS.size, fitted = null;

		if (verses) {
			for (var pass = 0; pass < 40; pass++) {
				fitted = measureBody(meter, verses, aSize, tSize, maxW,
					card.more, card.skipArabic);
				if (titleH + subH + 18 + fitted.height <= MAX_BODY ||
					(aSize <= M_MIN_ARABIC + 0.01 && tSize <= M_MIN_TRANS + 0.01)) {
					break;
				}
				aSize = Math.max(M_MIN_ARABIC, aSize * 0.95);
				tSize = Math.max(M_MIN_TRANS, tSize * 0.95);
			}
			bodyH = titleH + subH + 18 + fitted.height;
		} else {
			arabicLines = linesFor(meter, card.arabic, ARABIC, ARABIC.size, maxW, true);
			transLines = card.translation
				? linesFor(meter, card.translation, TRANS, TRANS.size, maxW, false) : [];
			bodyH = titleH + subH + 18 +
				arabicLines.length * ARABIC.size * ARABIC.line +
				(transLines.length
					? 20 + transLines.length * TRANS.size * TRANS.line : 0);
		}

		var bodyTop = PAD + Math.max(0, (MIN_BODY - bodyH) / 2);
		var cardH = Math.max(MIN_BODY, bodyH) + PAD * 2 + BAND;

		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(cardH * (OUTPUT_W / CARD_W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / CARD_W, OUTPUT_W / CARD_W);

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, CARD_W, cardH);

		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		function block(lines, spec, size, color, y, rtl) {
			ctx.font = fontFor(spec, size);
			ctx.fillStyle = color;
			ctx.direction = rtl ? 'rtl' : 'ltr';
			var lh = size * spec.line;
			for (var i = 0; i < lines.length; i++) {
				ctx.fillText(lines[i], CARD_W / 2, y + lh * (i + 0.5));
			}
			ctx.direction = 'ltr';
			return y + lh * lines.length;
		}

		var arColor = dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.87)';
		var trColor = dark ? 'rgba(255,255,255,.78)' : 'rgba(0,0,0,.72)';
		var subColor = dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.45)';

		var y = bodyTop;
		y = block(titleLines, TITLE, TITLE.size,
			dark ? '#9CC4FF' : '#4183C4', y, false);
		if (subLines.length) {
			y = block(subLines, SUB, SUB.size, subColor, y + 4, false) + 4;
		}
		y += 18;
		if (verses) {
			if (!fitted.skipArabic) {
				y = block(fitted.arabic, M_ARABIC, aSize, arColor, y, true);
			}
			if (fitted.trans.length) {
				if (!fitted.skipArabic) y += 22;
				var lh = tSize * M_TRANS.line;
				ctx.direction = 'ltr';
				for (var k = 0; k < fitted.trans.length; k++) {
					var line = fitted.trans[k];
					var ly = y + lh * (k + 0.5);
					var x = (CARD_W - line.width) / 2;
					ctx.textAlign = 'left';
					for (var n = 0; n < line.tokens.length; n++) {
						var tok = line.tokens[n];
						if (n) x += fitted.spaceW;
						ctx.font = fontFor(tok.marker ? M_ARABIC : M_TRANS,
							tok.marker ? tok.size : tSize);
						ctx.fillStyle = trColor;
						ctx.fillText(tok.text, x, ly);
						x += tok.width;
					}
					ctx.textAlign = 'center';
				}
				y += lh * fitted.trans.length;
			}
		} else {
			y = block(arabicLines, ARABIC, ARABIC.size, arColor, y, true);
			if (transLines.length) {
				block(transLines, TRANS, TRANS.size, trColor, y + 20, false);
			}
		}

		/* Brand band: the site name, then the full page URL under it. */
		var bandTop = cardH - BAND;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
		ctx.fillRect(0, bandTop, CARD_W, BAND);

		ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
		ctx.font = "600 15px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', CARD_W / 2, bandTop + BAND * 0.36);

		var label = String(card.url || '');
		var size = 11.5;
		var bandMax = CARD_W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > bandMax && size > 9) {
			size -= 0.5;
			ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		}
		ctx.fillText(label, CARD_W / 2, bandTop + BAND * 0.72);

		return out;
	}

	// canvas -> File without toBlob, so the whole share stays synchronous and
	// inside the tap (Safari drops the user activation across an await).
	function toFile(canvas, payload) {
		var href = canvas.toDataURL('image/png');
		var bin = atob(href.slice(href.indexOf(',') + 1));
		var bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new File([bytes],
			'aayatun-' + (payload.ref || 'share') + '.png',
			{ type: 'image/png' });
	}

	/* ------------------------------------------------------------- sharing */

	function flash(btn) {
		if (!btn) return;
		// Swap the icon, and the label when the button carries one, so a copy
		// that has no share sheet to show still ends in visible feedback.
		var icon = btn.querySelector('.icon');
		var label = btn.querySelector('span');
		var wasIcon = icon ? icon.className : '';
		var wasLabel = label ? label.textContent : '';
		if (icon) icon.className = 'icon check';
		if (label) label.textContent = 'Copied';
		window.setTimeout(function () {
			if (icon) icon.className = wasIcon;
			if (label) label.textContent = wasLabel;
		}, 1400);
	}

	function copyText(text, btn) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(function () {
				flash(btn);
			}, function () {
				window.prompt('Copy this text:', text);
			});
		}
		window.prompt('Copy this text:', text);
		return Promise.resolve();
	}

	function textShare(payload, btn) {
		if (!navigator.share) return copyText(payload.text, btn);
		var attempt;
		try {
			attempt = navigator.share({ title: payload.title, text: payload.text });
		} catch (e) {
			return copyText(payload.text, btn);
		}
		return Promise.resolve(attempt).catch(function (err) {
			if (err && err.name === 'AbortError') return;
			return copyText(payload.text, btn);
		});
	}

	// `file` is prebuilt when a caller already drew and encoded the card (the
	// map does, while its modal opens); undefined means draw it now.
	function shareCard(payload, card, btn, file) {
		if (file === undefined) {
			file = null;
			if (canShareFiles()) {
				try {
					file = toFile(drawCard(card), payload);
				} catch (e) {
					file = null;
				}
			}
		}
		return file ? shareFile(payload, file, btn) : textShare(payload, btn);
	}

	function shareFile(payload, file, btn) {
		if (!navigator.canShare({ files: [file] })) {
			return textShare(payload, btn);
		}
		var attempt;
		try {
			attempt = navigator.share({
				title: payload.title, text: payload.text, files: [file]
			});
		} catch (e) {
			return textShare(payload, btn);
		}
		return Promise.resolve(attempt).catch(function (err) {
			if (err && err.name === 'AbortError') return;
			return textShare(payload, btn);
		});
	}

	function share(payload, btn) {
		if (!payload) return Promise.resolve();
		var card = cardFor(payload);
		return card ? shareCard(payload, card, btn) : textShare(payload, btn);
	}

	function fromButton(btn) {
		return share(payloadFromButton(btn), btn);
	}

	function shareVerse(v) {
		return share(versePayload(v), byId('share-btn'));
	}

	// The map card carries the visit bitsets from recent.js, so the drawing
	// is just a paint pass: no DOM, no screenshot, and the same Web Share /
	// clipboard fallback as the reading views.
	// The message reads like the reader's own note, dated the day it is
	// shared, rather than like a product announcement.
	function todayLabel() {
		try {
			return new Date().toLocaleDateString(undefined, {
				day: 'numeric', month: 'long', year: 'numeric'
			});
		} catch (e) {
			return new Date().toDateString();
		}
	}

	function mapMessage() {
		return 'My Quran exploration so far, as of ' + todayLabel();
	}

	function mapPayload(o) {
		var url = pageUrl('/');
		return {
			kind: 'map',
			card: 'map',
			ref: 'quran-exploration-map',
			title: 'My Quran exploration — Aayatun',
			text: mapMessage() + '\n\n' +
				o.deep.toLocaleString() + ' of 6,236 verses studied · ' +
				o.pages + ' of 604 pages visited.\n\n' + url + '\n' + HASHTAG,
			url: url,
			deep: o.deep,
			pages: o.pages,
			states: o.states,
			starts: o.starts
		};
	}

	// The map card is the largest one (1080 x 1920 px) and encoding it takes
	// long enough to be felt as a lag between the tap and the share sheet, so
	// it is drawn and encoded once while the modal opens and the tap only
	// hands the finished file over. The signature covers the counts and the
	// bitset positions, so opening a verse or clearing history rebuilds it.
	var mapShare = { key: '', payload: null, file: null };

	function mapKey(o) {
		return (o.hash || 0) + ':' + (o.deep || 0) + ':' + (o.pages || 0);
	}

	function warmMapShare(o) {
		if (!o) return;
		var key = mapKey(o);
		if (mapShare.key === key) return;
		var payload = mapPayload(o);
		var file = null;
		if (canShareFiles()) {
			try {
				file = toFile(drawCard(cardFor(payload)), payload);
			} catch (e) {
				file = null;
			}
		}
		mapShare = { key: key, payload: payload, file: file };
	}

	function shareMap(o, btn) {
		var key = mapKey(o);
		if (mapShare.key !== key) warmMapShare(o);
		var cached = mapShare.key === key;
		var payload = cached ? mapShare.payload : mapPayload(o);
		return shareCard(payload, cached ? null : cardFor(payload),
			btn || byId('reading-map-share'), cached ? mapShare.file : undefined);
	}

	/* ---------------------------------------------------------------- init */

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', warmFonts);
	} else {
		warmFonts();
	}

	window.AayatunShare = {
		fromButton: fromButton,
		shareVerse: shareVerse,
		shareMap: shareMap,
		warmMapShare: warmMapShare,
		payloadFromButton: payloadFromButton,
		cardFor: cardFor,
		drawCard: drawCard
	};
})();
