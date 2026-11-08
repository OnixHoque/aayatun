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
 * first five verses (or the whole surah when it is shorter), shrinking both
 * faces until the body fits the card. The site name and the full URL sit in a
 * small band at the bottom. No buttons, legends or credits, and nothing
 * depends on what happens to be scrolled into view.
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
	var SCALE = 2;            // output pixels per CSS pixel
	var CARD_W = 420;         // CSS px wide card
	var PAD = 20;             // CSS px card padding
	var BAND = 64;            // CSS px of branding band
	var MIN_BODY = 220;       // keep very short verses from making a strip

	var TITLE = { weight: 700, family: 'Merriweather, Georgia, serif', size: 24, line: 1.3 };
	var SUB = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 13, line: 1.5 };
	var ARABIC = { weight: 700, family: 'Scheherazade, serif', size: 30, line: 1.75 };
	var TRANS = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 15, line: 1.55 };
	// Multi-verse cards carry five verses, so they start a little smaller and
	// shrink (down to the minimums) until the body fits MAX_BODY.
	var M_ARABIC = { weight: 700, family: 'Scheherazade, serif', size: 26, line: 1.7 };
	var M_TRANS = { weight: 400, family: "'Open Sans', system-ui, sans-serif", size: 13, line: 1.5 };
	var M_MIN_ARABIC = 17;
	var M_MIN_TRANS = 9.5;
	var MAX_BODY = 1200;      // CSS px of text before the fit pass shrinks it

	var VIEW_LABEL = {
		arabic: 'Arabic text with translation',
		translation: 'English translation',
		'tafsir-en': "Ibn Kathir's tafsir",
		'tafsir-bn': 'Bangla tafsir (Abu Bakr Zakaria)'
	};

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

	function canShareFiles() {
		try {
			if (!navigator.canShare || !window.File || !window.Blob) return false;
			var bytes = atob(TINY_PNG);
			var arr = new Uint8Array(bytes.length);
			for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
			var probe = new File([arr], 'probe.png', { type: 'image/png' });
			return navigator.canShare({ files: [probe] });
		} catch (e) {
			return false;
		}
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
			if (!card.verses) card.arabic = firstVerseText();
		} else if (payload.card === 'page') {
			card.title = 'Mushaf page ' + payload.page;
			card.subtitle = payload.range || '';
			card.verses = payload.verses;
			if (!card.verses) card.arabic = firstVerseText();
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
			if (!line || ctx.measureText(next).width <= maxW) {
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

	// Interleaved multi-verse body: each verse's Arabic paragraph, then its
	// translation in smaller text underneath. Measured at one size pair so the
	// fit pass can shrink both faces until the body fits.
	function measureVerses(ctx, verses, aSize, tSize, maxW) {
		var blocks = [];
		var height = 0;
		for (var i = 0; i < verses.length; i++) {
			var v = verses[i];
			var arabic = linesFor(ctx, v[2], M_ARABIC, aSize, maxW, true);
			var translation = v[3]
				? linesFor(ctx, v[3], M_TRANS, tSize, maxW, false) : [];
			var h = arabic.length * aSize * M_ARABIC.line;
			if (translation.length) {
				h += 6 + translation.length * tSize * M_TRANS.line;
			}
			height += i ? 16 + h : h;
			blocks.push({ arabic: arabic, translation: translation });
		}
		return { blocks: blocks, height: height };
	}

	function drawCard(card) {
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
				fitted = measureVerses(meter, verses, aSize, tSize, maxW);
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
		out.width = Math.round(CARD_W * SCALE);
		out.height = Math.round(cardH * SCALE);
		var ctx = out.getContext('2d');
		ctx.scale(SCALE, SCALE);

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
			for (var v = 0; v < fitted.blocks.length; v++) {
				var b = fitted.blocks[v];
				if (v) y += 16;
				y = block(b.arabic, M_ARABIC, aSize, arColor, y, true);
				if (b.translation.length) {
					y = block(b.translation, M_TRANS, tSize, trColor, y + 6, false);
				}
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
		ctx.font = "600 14px 'Open Sans', system-ui, sans-serif";
		ctx.fillText('aayatun.com', CARD_W / 2, bandTop + BAND * 0.36);

		var label = String(card.url || '');
		var size = 10.5;
		var bandMax = CARD_W - PAD * 2;
		ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
		ctx.font = "400 " + size + "px 'Open Sans', system-ui, sans-serif";
		while (label && ctx.measureText(label).width > bandMax && size > 8) {
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
		var old = btn.innerHTML;
		btn.innerHTML = '<i class="icon check" aria-hidden="true"></i>';
		window.setTimeout(function () { btn.innerHTML = old; }, 1200);
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

	function shareCard(payload, card, btn) {
		var file = null;
		if (canShareFiles()) {
			try {
				file = toFile(drawCard(card), payload);
			} catch (e) {
				file = null;
			}
		}
		if (!file || !navigator.canShare({ files: [file] })) {
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

	/* ---------------------------------------------------------------- init */

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', warmFonts);
	} else {
		warmFonts();
	}

	window.AayatunShare = {
		fromButton: fromButton,
		shareVerse: shareVerse,
		payloadFromButton: payloadFromButton,
		cardFor: cardFor,
		drawCard: drawCard
	};
})();
