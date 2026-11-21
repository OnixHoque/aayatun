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
 * Tafsir and theme views are text-only.
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

	function themeText(o) {
		return 'Theme ‘' + o.theme + '’ — ' + o.count +
			' verses of the Quran on Aayatun.\n\nRead on Aayatun: ' + o.url +
			'\n' + HASHTAG;
	}

	function quizText(o) {
		var ref = (o.surah && o.verse)
			? ' (' + shortName(o.surah_name) + ' ' + o.surah + ':' + o.verse + ')'
			: '';
		return 'I scored ' + o.score + '/' + o.total +
			' on the Aayatun Quran Quiz' + ref + '. Can you beat me?\n\n' + o.url +
			'\n' + HASHTAG;
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
		} else if (kind === 'theme') {
			var tcount = parseInt(d.themeCount, 10) || 0;
			payload.title = 'Aayatun — Theme: ' + d.theme;
			payload.text = themeText({
				theme: d.theme, count: tcount, url: payload.url
			});
			payload.theme = d.theme;
			payload.themeCount = tcount;
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
		} else if (payload.card === 'quiz') {
			card.kind = 'quiz';
			card.score = payload.score || 0;
			card.total = payload.total || 5;
			card.subtitle = todayLabel();
			if (payload.surah && payload.verse) {
				card.surah = payload.surah;
				card.verse = payload.verse;
				card.title = 'Quran ' + payload.surah + ':' + payload.verse;
			} else {
				card.title = 'Quran Quiz';
			}
			return card;
		} else if (payload.card === 'reel') {
			card.kind = 'reel';
			card.title = payload.title || (shortName(payload.name) + ' ' + payload.surah + ':' + payload.verse);
			card.arabic = payload.arabic || payload.ayah;
			card.translation = payload.translation;
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
		var PAD = 34;

		// A story-sized poster for a social post: small kicker, the
		// headline count as the hero, the map, one caption, one CTA.
		var cardH = MAP_CARD_H;
		var kickerY = 74;
		var heroY = 190;
		var subY = 262;
		var metaY = 292;
		var mapTop = 346;
		var captionY = mapTop + mapH + 34;
		var tagY = captionY + 62;
		var hashY = tagY + 28;

		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(cardH * (OUTPUT_W / MAP_W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / MAP_W, OUTPUT_W / MAP_W);
		ctx.textBaseline = 'middle';

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, MAP_W, cardH);

		var titleColor = dark ? '#9CC4FF' : '#4183C4';
		var body = dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.82)';
		var muted = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.48)';
		var none = dark ? [42, 47, 54] : [230, 233, 236];
		var light = dark ? [14, 68, 41] : [155, 233, 168];
		var deep1 = dark ? [0, 109, 50] : [64, 196, 99];
		var deep2 = dark ? [38, 166, 65] : [48, 161, 78];
		var deep3 = dark ? [57, 211, 83] : [33, 110, 57];
		var shades = [none, light, deep1, deep2, deep3];

		var pagesPct = (card.pages / MAP_PAGES) * 100;
		var versesPct = (card.deep / MAP_VERSES) * 100;

		// Kicker: the view, small and tracked out.
		ctx.textAlign = 'center';
		try { ctx.letterSpacing = '4px'; } catch (e) {}
		ctx.fillStyle = muted;
		ctx.font = "700 15px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('QURAN EXPLORATION MAP', MAP_W / 2, kickerY);
		try { ctx.letterSpacing = '0px'; } catch (e) {}

		// Hero: the count as one big line, shrinking until it fits.
		var hero = (card.deep || 0).toLocaleString() + ' / 6,236';
		var heroSize = 118;
		ctx.fillStyle = titleColor;
		while (heroSize > 60) {
			ctx.font = "700 " + heroSize + "px Merriweather, Georgia, serif";
			if (ctx.measureText(hero).width <= MAP_W - PAD * 2) break;
			heroSize -= 4;
		}
		ctx.fillText(hero, MAP_W / 2, heroY);

		// Subline and one quiet meta line under the hero.
		ctx.fillStyle = body;
		ctx.font = "400 21px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('verses of the Quran explored', MAP_W / 2, subY);
		ctx.fillStyle = muted;
		ctx.font = "400 15px 'Open Sans', system-ui, sans-serif";
		ctx.fillText((card.pages || 0) + ' of 604 pages visited · ' + pctLabel(versesPct),
			MAP_W / 2, metaY);

		// The map as one bitmap, subsampled verse by verse.
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

		// One italic caption under the map — all the explanation it gets.
		ctx.fillStyle = muted;
		ctx.font = "italic 400 17px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('Every square is one verse of the Quran.', MAP_W / 2, captionY);

		// The CTA: one big line, auto-fitted, and the hashtag under it.
		var tag = 'Track your own reading at aayatun.com';
		var tagSize = 26;
		ctx.fillStyle = titleColor;
		while (tagSize > 14) {
			ctx.font = "700 " + tagSize + "px 'Open Sans', system-ui, sans-serif";
			if (ctx.measureText(tag).width <= MAP_W - PAD * 2) break;
			tagSize -= 1;
		}
		ctx.fillText(tag, MAP_W / 2, tagY);
		ctx.fillStyle = muted;
		ctx.font = "400 15px 'Open Sans', system-ui, sans-serif";
		ctx.fillText(HASHTAG, MAP_W / 2, hashY);

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

	// Quran Quiz card: a square-ish score card — kicker, title, big ring
	// with the score inside, date, and the brand band.
	var QUIZ_H = 400;

	function drawQuizCard(card) {
		var dark = isDark();
		var W = CARD_W;
		var H = QUIZ_H;

		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(H * (OUTPUT_W / W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / W, OUTPUT_W / W);
		ctx.textBaseline = 'middle';

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, W, H);

		var titleColor = dark ? '#9CC4FF' : '#4183C4';
		var body = dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.82)';
		var muted = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.48)';
		var track = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.09)';

		var total = card.total || 5;
		var pct = total ? Math.min(1, (card.score || 0) / total) : 0;
		var ringColor = pct >= 0.7 ? '#16a34a' : (pct >= 0.4 ? '#d97706' : '#dc2626');

		ctx.textAlign = 'center';

		// Kicker.
		try { ctx.letterSpacing = '4px'; } catch (e) {}
		ctx.fillStyle = muted;
		ctx.font = "700 12px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('QURAN QUIZ', W / 2, 54);
		try { ctx.letterSpacing = '0px'; } catch (e) {}

		// Title.
		ctx.fillStyle = titleColor;
		ctx.font = "700 26px Merriweather, Georgia, serif";
		ctx.fillText(card.title || 'Quran Quiz', W / 2, 96);

		// Score ring.
		var cx = W / 2, cy = 212, r = 56;
		ctx.lineWidth = 13;
		ctx.lineCap = 'round';
		ctx.strokeStyle = track;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.stroke();
		ctx.strokeStyle = ringColor;
		ctx.beginPath();
		ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
		ctx.stroke();

		ctx.fillStyle = body;
		ctx.font = "700 38px Merriweather, Georgia, serif";
		ctx.fillText(card.score + '/' + total, cx, cy - 8);
		ctx.fillStyle = muted;
		ctx.font = "400 13px 'Open Sans', system-ui, sans-serif";
		ctx.fillText(Math.round(pct * 100) + '%', cx, cy + 22);

		// Meta line under the ring.
		ctx.fillStyle = muted;
		ctx.font = "400 12.5px 'Open Sans', system-ui, sans-serif";
		ctx.fillText((card.subtitle || '') + '  ·  ' + total +
			' questions · 30 seconds each', W / 2, 324);

		/* Brand band. */
		var bandTop = H - BAND;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
		ctx.fillRect(0, bandTop, W, BAND);
		ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
		ctx.font = "600 16px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', W / 2, bandTop + BAND * 0.36);

		var label = String(card.url || '');
		var size = 12;
		var bandMax = W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > bandMax && size > 9) {
			size -= 0.5;
			ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		}
		ctx.fillText(label, W / 2, bandTop + BAND * 0.72);

		return out;
	}

	function drawReelCard(card) {
		// Matches the reel opening screen: title on top, Arabic fills the top
		// 75% of the space below it, translation fills the bottom 25%.
		// Story-sized 9:16 poster (460 x 818 CSS px, rendered at 1080 x 1920).
		var dark = isDark();
		var W = 460;
		var H = 818;

		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(H * (OUTPUT_W / W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / W, OUTPUT_W / W);
		ctx.textBaseline = 'middle';

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, W, H);

		var titleColor = dark ? '#9CC4FF' : '#4183C4';
		var body = dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.82)';
		var muted = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.58)';

		var PADX = 30;
		var PADT = 34;
		var BANDH = 70;
		var maxW = W - PADX * 2;
		var contentBottom = H - BANDH - 10;

		ctx.textAlign = 'center';

		// Title (kept on top)
		var title = card.title || '';
		var titleSize = 20;
		ctx.font = "700 " + titleSize + "px Merriweather, Georgia, serif";
		while (title && ctx.measureText(title).width > maxW && titleSize > 12) {
			titleSize -= 1;
			ctx.font = "700 " + titleSize + "px Merriweather, Georgia, serif";
		}
		var titleY = PADT + titleSize * 0.7;
		ctx.fillStyle = titleColor;
		ctx.fillText(title, W / 2, titleY);

		// Space below the title, split 75% Arabic / 25% translation.
		var bodyTop = titleY + titleSize * 0.9;
		var bodyH = Math.max(80, contentBottom - bodyTop);
		var arabicBoxH = bodyH * 0.75;
		var transBoxH = bodyH * 0.25;

		var arabic = String(card.arabic || '').trim();
		var translation = String(card.translation || '').trim();

		// A long translation needs more than a quarter of the card; grow its
		// box (shrinking the Arabic block) so the card never clips it.
		if (translation) {
			var tMinProbe = 11;
			var tNeed = linesFor(ctx, translation, TRANS, tMinProbe, maxW, false).length *
				(tMinProbe * TRANS.line) + 6;
			if (tNeed > transBoxH) {
				transBoxH = Math.min(tNeed, bodyH * 0.55);
				arabicBoxH = bodyH - transBoxH;
			}
		}

		// Arabic: largest size that fits the 75% box, bottom-aligned.
		var aSize = Math.min(arabicBoxH * 0.55, 96);
		var aLines = [], aLineH = 0, aH = 0;
		for (var ap = 0; ap < 90; ap++) {
			aLines = linesFor(ctx, arabic, ARABIC, aSize, maxW, true);
			aLineH = aSize * ARABIC.line;
			aH = aLines.length * aLineH;
			if (aH <= arabicBoxH - 2 || aSize <= 11) break;
			aSize -= 1;
		}
		ctx.textAlign = 'center';
		ctx.direction = 'rtl';
		ctx.fillStyle = body;
		ctx.font = fontFor(ARABIC, aSize);
		var ay = bodyTop + Math.max(0, arabicBoxH - aH) + aSize * 0.75;
		for (var i = 0; i < aLines.length; i++) {
			ctx.fillText(aLines[i], W / 2, ay);
			ay += aLineH;
		}
		ctx.direction = 'ltr';

		// Translation: largest size that fits the 25% box, top-aligned.
		var tSize = Math.min(transBoxH * 0.55, 36);
		var tLines = [], tLineH = 0, tH = 0;
		for (var tp = 0; tp < 90; tp++) {
			tLines = translation ? linesFor(ctx, translation, TRANS, tSize, maxW, false) : [];
			tLineH = tSize * TRANS.line;
			tH = tLines.length * tLineH;
			if (tH <= transBoxH - 2 || tSize <= 11) break;
			tSize -= 1;
		}
		if (tLines.length) {
			ctx.textAlign = 'center';
			ctx.fillStyle = muted;
			ctx.font = fontFor(TRANS, tSize);
			var ty = bodyTop + arabicBoxH + 8 + tSize * 0.7;
			for (var j = 0; j < tLines.length; j++) {
				ctx.fillText(tLines[j], W / 2, ty);
				ty += tLineH;
			}
		}

		// Brand band
		var bandTop = H - BANDH;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
		ctx.fillRect(0, bandTop, W, BANDH);
		ctx.textAlign = 'center';
		ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
		ctx.font = "600 16px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', W / 2, bandTop + BANDH * 0.36);
		var label = String(card.url || '');
		var lSize = 12;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + lSize + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > maxW && lSize > 9) {
			lSize -= 0.5;
			ctx.font = "400 " + lSize + "px 'Open Sans', system-ui, sans-serif";
		}
		ctx.fillText(label, W / 2, bandTop + BANDH * 0.72);
		return out;
	}

	function drawCard(card) {
		if (card.kind === 'map') return drawMapCard(card);
		if (card.kind === 'quiz') return drawQuizCard(card);
		if (card.kind === 'reel') return drawReelCard(card);
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
		return 'Every square is one verse of the Quran. This is how far I have explored as of ' + todayLabel() + '.';
	}

	function mapPayload(o) {
		var url = pageUrl('/');
		return {
			kind: 'map',
			card: 'map',
			ref: 'quran-exploration-map',
			title: 'My Quran exploration — Aayatun',
			text: 'I have explored ' + o.deep.toLocaleString() + ' of 6,236 verses and ' +
				o.pages + ' of 604 pages of the Quran. Track your own reading journey ' +
				'with the Quran Exploration Map on Aayatun.\n\n' + url + '\n' + HASHTAG,
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

	function shareQuiz(o, btn) {
		var url = pageUrl('/quiz');
		var ref = (o.surah && o.verse) ? (o.surah + ':' + o.verse) : '';
		return share({
			kind: 'quiz',
			card: 'quiz',
			ref: ref ? ('quiz-' + o.surah + '-' + o.verse) : 'quiz-result',
			title: 'My Aayatun Quran Quiz score — Aayatun',
			text: quizText({
				score: o.score, total: o.total, url: url,
				surah: o.surah, verse: o.verse, surah_name: o.surah_name
			}),
			url: url,
			score: o.score,
			total: o.total,
			surah: o.surah,
			verse: o.verse,
			surah_name: o.surah_name
		}, btn || byId('quiz-share-btn'));
	}

	function shareMap(o, btn) {
		var key = mapKey(o);
		if (mapShare.key !== key) warmMapShare(o);
		var cached = mapShare.key === key;
		var payload = cached ? mapShare.payload : mapPayload(o);
		return shareCard(payload, cached ? null : cardFor(payload),
			btn || byId('reading-map-share'), cached ? mapShare.file : undefined);
	}

	function shareReel(o, btn) {
		var url = pageUrl('/reel/' + o.surah + '/' + o.verse);
		var ref = shortName(o.name) + ' ' + o.surah + ':' + o.verse;
		var text = ref + '\n\n' + (o.ayah || '').trim() + '\n\n' +
			(o.translation || '').trim() + '\n\nWatch on Aayatun: ' + url +
			'\n' + HASHTAG;
		var payload = {
			kind: 'reel',
			card: 'reel',
			ref: 'reel-' + o.surah + '-' + o.verse,
			title: 'Aayatun · ' + ref,
			text: text,
			url: url,
			surah: o.surah,
			verse: o.verse,
			name: o.name,
			ayah: o.ayah,
			arabic: o.ayah,
			translation: o.translation
		};
		// Share first-scene image (75% verse / 25% translation, matching the
		// reel opening screen) with a text fallback.
		return share(payload, btn || byId('reel-share'));
	}

	/* ---------------------------------------------------- animated reel (disabled; reel shares as link)
	function drawReelCardFrame(card, progress) {
		// progress 0..1: how many words revealed (word-by-word, first 5s)
		var dark = isDark();
		var W = CARD_W;
		var H = Math.round(W * 16 / 9);
		var out = document.createElement('canvas');
		out.width = OUTPUT_W;
		out.height = Math.round(H * (OUTPUT_W / W));
		var ctx = out.getContext('2d');
		ctx.scale(OUTPUT_W / W, OUTPUT_W / W);
		ctx.textBaseline = 'middle';

		ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
		ctx.fillRect(0, 0, W, H);

		var titleColor = dark ? '#9CC4FF' : '#4183C4';
		var body = dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.82)';
		var muted = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.48)';
		var accent = dark ? '#9CC4FF' : '#4183C4';

		var maxW = W - PAD * 2;
		var arabic = String(card.arabic || '').trim();
		var tFull = String(card.translation || '').trim();
		var top = 150;
		var bottomLimit = H - BAND - 28;

		if (!card._animLayout) {
			var aSize = 34;
			var lay = null;
			for (var pass = 0; pass < 30; pass++) {
				var aLines = linesFor(ctx, arabic, ARABIC, aSize, maxW, true);
				var aH = aLines.length * aSize * ARABIC.line;
				var tSize = Math.max(13, Math.min(17, aSize * 0.5));
				var tLines = tFull ? linesFor(ctx, tFull, TRANS, tSize, maxW, false) : [];
				var tH = tLines.length ? 18 + tLines.length * tSize * TRANS.line : 0;
				if (top + aH + tH <= bottomLimit || aSize <= 18) {
					lay = { aSize: aSize, tSize: tSize, aLines: aLines, tLines: tLines, aH: aH, tH: tH };
					break;
				}
				aSize -= 1;
			}
			if (!lay) {
				lay = { aSize: 18, tSize: 13, aLines: linesFor(ctx, arabic, ARABIC, 18, maxW, true), tLines: tFull ? linesFor(ctx, tFull, TRANS, 13, maxW, false) : [] };
				lay.aH = lay.aLines.length * lay.aSize * ARABIC.line;
				lay.tH = lay.tLines.length ? 18 + lay.tLines.length * lay.tSize * TRANS.line : 0;
			}
			card._animLayout = lay;
		}
		var L = card._animLayout;

		ctx.textAlign = 'center';

		// Kicker
		try { ctx.letterSpacing = '4px'; } catch (e) {}
		ctx.fillStyle = muted;
		ctx.font = "700 12px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('WORD BY WORD', W / 2, 54);
		try { ctx.letterSpacing = '0px'; } catch (e) {}

		// Title
		ctx.fillStyle = titleColor;
		ctx.font = "700 24px Merriweather, Georgia, serif";
		ctx.fillText(card.title || '', W / 2, 96);

		var words = (card.words && card.words.length) ? card.words : String(arabic).split(/\s+/).filter(Boolean);
		var total = words.length || 1;
		var shown = Math.max(0, Math.min(total, Math.ceil(total * progress)));
		var shownAr = [];
		for (var si = 0; si < shown; si++) shownAr.push(words[si] && words[si].ar ? words[si].ar : String(words[si] || ''));
		var arText = shownAr.join(' ');
		var arDrawLines = arText ? linesFor(ctx, arText, ARABIC, L.aSize, maxW, true) : [];

		ctx.direction = 'rtl';
		ctx.font = fontFor(ARABIC, L.aSize);
		var y = top + L.aSize * 0.8;
		for (var i = 0; i < arDrawLines.length; i++) {
			ctx.fillStyle = body;
			ctx.fillText(arDrawLines[i], W / 2, y);
			y += L.aSize * ARABIC.line;
		}
		ctx.direction = 'ltr';

		// Translation revealed progressively; positioned below full Arabic block for stability
		if (tFull) {
			var tShownCount = Math.max(0, Math.min(tFull.length, Math.ceil(tFull.length * progress)));
			var tText = tFull.slice(0, tShownCount);
			var tDrawLines = tText ? linesFor(ctx, tText, TRANS, L.tSize, maxW, false) : [];
			var ty = top + L.aH + 18 + L.tSize * 0.4;
			ctx.fillStyle = muted;
			ctx.font = fontFor(TRANS, L.tSize);
			ctx.textAlign = 'center';
			for (var j = 0; j < tDrawLines.length; j++) {
				ctx.fillText(tDrawLines[j], W / 2, ty);
				ty += L.tSize * TRANS.line;
			}
		}

		// Progress bar
		var barY = H - BAND - 18;
		var barW = W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)';
		ctx.fillRect(PAD, barY, barW, 4);
		ctx.fillStyle = accent;
		ctx.fillRect(PAD, barY, barW * Math.min(1, progress), 4);

		// Brand band
		var bandTop = H - BAND;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
		ctx.fillRect(0, bandTop, W, BAND);
		ctx.textAlign = 'center';
		ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
		ctx.font = "600 16px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', W / 2, bandTop + BAND * 0.36);
		var label = String(card.url || '');
		var size = 12;
		var bandMax = W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > bandMax && size > 9) {
			size -= 0.5;
			ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		}
		ctx.fillText(label, W / 2, bandTop + BAND * 0.72);
		return out;
	}

	function recordReelAnimation(card) {
		return new Promise(function (resolve, reject) {
			var duration = 5000;
			var fps = 15;
			var canvas = drawReelCardFrame(card, 0);
			var stream = canvas.captureStream ? canvas.captureStream(fps) : null;
			if (!stream || typeof MediaRecorder === 'undefined') { reject(new Error('no recorder')); return; }

			var mime = '';
			var types = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
			for (var ti = 0; ti < types.length; ti++) {
				try { if (MediaRecorder.isTypeSupported(types[ti])) { mime = types[ti]; break; } } catch (e) {}
			}
			var opts = mime ? { mimeType: mime } : undefined;
			var recorder;
			try { recorder = new MediaRecorder(stream, opts); } catch (e) { reject(e); return; }
			var chunks = [];
			recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
			recorder.onerror = function () { reject(new Error('recorder error')); };
			recorder.onstop = function () {
				var type = recorder.mimeType || mime || 'video/webm';
				resolve(new Blob(chunks, { type: type }));
			};

			var start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
			function step() {
				var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
				var t = Math.min(1, (now - start) / duration);
				// ease-out a bit so it completes nicely
				var p = 1 - Math.pow(1 - t, 1.4);
				var frame = drawReelCardFrame(card, p);
				var c2 = canvas.getContext('2d');
				c2.clearRect(0, 0, canvas.width, canvas.height);
				c2.drawImage(frame, 0, 0);
				if (t < 1) {
					setTimeout(step, 1000 / fps);
				} else {
					// final full frame
					var finalFrame = drawReelCardFrame(card, 1);
					c2.clearRect(0, 0, canvas.width, canvas.height);
					c2.drawImage(finalFrame, 0, 0);
					setTimeout(function () { try { recorder.stop(); } catch (e) { reject(e); } }, 150);
				}
			}

			try { recorder.start(); } catch (e) { reject(e); return; }
			step();
		});
	}

	function downloadBlob(blob, name) {
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1000);
	}

	function shareReelAnimated(payload, btn) {
		// Generate 5s word-by-word animation video and share it.
		if (!canShareFiles() || typeof MediaRecorder === 'undefined') return Promise.reject(new Error('no support'));
		var card = cardFor(payload);
		if (btn) btn.classList.add('loading');
		return recordReelAnimation(card).then(function (blob) {
			if (btn) btn.classList.remove('loading');
			var ext = (blob.type && blob.type.indexOf('mp4') !== -1) ? 'mp4' : 'webm';
			var file = new File([blob], 'aayatun-reel-' + payload.surah + '-' + payload.verse + '.' + ext, { type: blob.type || 'video/webm' });
			// Try to share; if user activation is lost or share fails, download.
			if (navigator.canShare && navigator.canShare({ files: [file] })) {
				return navigator.share({ title: payload.title, text: payload.text, files: [file] }).catch(function (err) {
					if (err && err.name === 'AbortError') return;
					downloadBlob(blob, file.name);
					flash(btn);
				});
			}
			downloadBlob(blob, file.name);
			flash(btn);
		}).catch(function (e) {
			if (btn) btn.classList.remove('loading');
			throw e;
		});
	}
	---------------------------------------------------- animated reel disabled */

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
		shareQuiz: shareQuiz,
		shareReel: shareReel,
		warmMapShare: warmMapShare,
		payloadFromButton: payloadFromButton,
		cardFor: cardFor,
		drawCard: drawCard
	};
})();
