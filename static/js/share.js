/*
 * Sharing for Aayatun's reading views.
 *
 * One module builds the social-media text for every view (verse, whole surah,
 * printed mushaf page), calls the Web Share API when available, and falls back
 * to copying the formatted text.
 *
 * The verse page, the arabic surah view and the mushaf page also get a PNG
 * card, drawn on a canvas instead of screenshotted: the reference in
 * Merriweather at the top, the plain Uthmani Arabic (never the tajweed/QCF
 * glyphs), the translation on the verse page only, and the site name plus the
 * full URL in a small band at the bottom. No buttons, legends or credits, and
 * nothing depends on what happens to be scrolled into view.
 *
 * Drawing is synchronous, so the file can be produced inside the tap: Safari
 * requires navigator.share() to run within the user gesture, and a canvas
 * costs a few milliseconds where html2canvas cost a few hundred. Where the
 * browser cannot attach files, the text is shared (or copied) instead.
 *
 * Translation and tafsir views are text-only.
 */
(function () {
	'use strict';

	var HASHTAG = '#aayatun';
	var SCALE = 2;            // output pixels per CSS pixel
	var CARD_W = 420;         // CSS px wide card
	var PAD = 20;             // CSS px card padding
	var BAND = 64;            // CSS px of branding band
	var MIN_BODY = 220;       // keep very short verses from making a strip

	var TITLE = { font: '700 24px Merriweather, Georgia, serif', size: 24, line: 1.3 };
	var SUB = { font: "400 13px 'Open Sans', system-ui, sans-serif", size: 13, line: 1.5 };
	var ARABIC = { font: "700 30px Scheherazade, serif", size: 30, line: 1.75 };
	var TRANS = { font: "400 15px 'Open Sans', system-ui, sans-serif", size: 15, line: 1.55 };

	var VIEW_LABEL = {
		arabic: 'Arabic text with translation',
		translation: 'English translation',
		'tafsir-en': "Ibn Kathir's tafsir",
		'tafsir-bn': 'Bangla tafsir (Abu Bakr Zakaria)'
	};

	var TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

	function byId(id) { return document.getElementById(id); }
	function noop() {}
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
		return 'Madani mushaf page ' + o.page +
			(o.range ? ' — ' + o.range : '') +
			'\n\nRead on Aayatun: ' + o.url + '\n' + HASHTAG;
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
		if (kind === 'surah') {
			payload.title = 'Aayatun — Surah ' + shortName(d.name);
			payload.text = surahText({
				name: d.name, surah: d.surah, view: d.view, url: payload.url
			});
			payload.surah = d.surah;
			payload.name = d.name;
			// Only the arabic view has a verse to put on a card.
			if (d.view === 'arabic') payload.card = 'arabic';
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
	// have been fetched at all — ask for all three faces once at load.
	function warmFonts() {
		if (!document.fonts || !document.fonts.load) return;
		var faces = [TITLE.font, ARABIC.font, TRANS.font];
		for (var i = 0; i < faces.length; i++) {
			try { document.fonts.load(faces[i]).catch(noop); } catch (e) {}
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
		} else if (payload.card === 'arabic') {
			card.title = shortName(payload.name) + ' (' + payload.surah + ')';
			card.arabic = firstVerseText();
		} else if (payload.card === 'page') {
			card.title = 'Madani mushaf page ' + payload.page;
			card.subtitle = payload.range || '';
			card.arabic = firstVerseText();
		} else {
			return null;
		}

		if (!card.arabic) return null;
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

	function linesFor(ctx, text, spec, maxW, rtl) {
		ctx.direction = rtl ? 'rtl' : 'ltr';
		ctx.font = spec.font;
		var lines = wrap(ctx, text, maxW);
		ctx.direction = 'ltr';
		return lines;
	}

	function drawCard(card) {
		var maxW = CARD_W - PAD * 2;
		var dark = isDark();

		// Measure first (off-screen), then size the real canvas.
		var meter = document.createElement('canvas').getContext('2d');
		var titleLines = linesFor(meter, card.title, TITLE, maxW, false);
		var subLines = card.subtitle
			? linesFor(meter, card.subtitle, SUB, maxW, false) : [];
		var arabicLines = linesFor(meter, card.arabic, ARABIC, maxW, true);
		var transLines = card.translation
			? linesFor(meter, card.translation, TRANS, maxW, false) : [];

		var titleH = titleLines.length * TITLE.size * TITLE.line;
		var subH = subLines.length * SUB.size * SUB.line;
		var arabicH = arabicLines.length * ARABIC.size * ARABIC.line;
		var transH = transLines.length * TRANS.size * TRANS.line;

		var bodyH = titleH +
			(subLines.length ? subH + 4 : 0) + 18 +
			arabicH +
			(transLines.length ? 20 + transH : 0);
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

		function block(lines, spec, color, y, rtl) {
			ctx.font = spec.font;
			ctx.fillStyle = color;
			ctx.direction = rtl ? 'rtl' : 'ltr';
			var lh = spec.size * spec.line;
			for (var i = 0; i < lines.length; i++) {
				ctx.fillText(lines[i], CARD_W / 2, y + lh * (i + 0.5));
			}
			ctx.direction = 'ltr';
			return y + lh * lines.length;
		}

		var y = bodyTop;
		y = block(titleLines, TITLE, dark ? '#9CC4FF' : '#4183C4', y, false);
		if (subLines.length) {
			y = block(subLines, SUB,
				dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.45)', y + 4, false) + 4;
		}
		y = block(arabicLines, ARABIC,
			dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.87)', y + 18, true);
		if (transLines.length) {
			block(transLines, TRANS,
				dark ? 'rgba(255,255,255,.78)' : 'rgba(0,0,0,.72)', y + 20, false);
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
