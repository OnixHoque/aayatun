/*
 * Native sharing for Aayatun's reading views.
 *
 * One module builds the social-media text for every view (verse, whole surah,
 * printed mushaf page), calls the Web Share API when available, and falls back
 * to copying the formatted text. It also attaches a PNG of what is on screen:
 * the page's content column is captured with html2canvas (loaded on demand),
 * cropped to the visible viewport, and composed on a themed card with
 * "aayatun.com" and the full URL in a small band at the bottom.
 *
 * Nothing is captured outside the viewport, so the image always matches what
 * the reader is looking at, and it stays small enough for a share sheet.
 *
 * The image is prepared ahead of the tap: Safari requires navigator.share() to
 * run inside the user gesture, so waiting for html2canvas after the click
 * would lose the activation. It is rebuilt after scrolling stops, on resize
 * and after the surah tables repaginate. When file sharing is unavailable
 * (most desktop browsers) the PNG is saved and the text copied instead.
 */
(function () {
	'use strict';

	var HASHTAG = '#aayatun';
	var H2C_CDN = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
	var SCALE = 2;
	var BAND = 64;           // CSS px of branding band
	var PAD = 20;            // CSS px of card padding
	var CACHE_MAX = 2;

	var cache = {};          // key -> Promise<{file, shot}|null>
	var cacheOrder = [];
	var ready = {};          // key -> {file, shot}
	var h2cPromise = null;
	var verseTimer = null;
	var scrollTimer = null;
	var activePayload = null;
	var allPayloads = [];

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
	function origin() { return window.location.origin; }
	function pageUrl(path) { return new URL(path, origin()).href; }

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

	function versePayload(v) {
		var url = pageUrl('/' + v.surah + '/' + v.verse);
		return {
			kind: 'verse',
			ref: 'ayah-' + v.surah + '-' + v.verse,
			title: 'Aayatun — ' + shortName(v.name) + ' ' + v.surah + ':' + v.verse,
			text: verseText({
				name: v.name, surah: v.surah, verse: v.verse,
				translation: v.translation, url: url
			}),
			url: url
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
		} else if (kind === 'page') {
			payload.title = 'Aayatun — Mushaf page ' + d.page;
			payload.text = pageText({
				page: d.page, range: d.range, url: payload.url
			});
		} else if (kind === 'verse') {
			payload.title = d.shareTitle || 'Aayatun';
			payload.text = d.shareText || '';
			payload.url = d.shareUrl || window.location.href;
		} else {
			return null;
		}
		return payload;
	}

	/* --------------------------------------------------------------- files */

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

	function isIOSSafari() {
		var ua = navigator.userAgent || '';
		if (/iPad|iPhone|iPod/.test(ua)) return true;
		return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
	}

	function loadHtml2Canvas() {
		if (window.html2canvas) return Promise.resolve(window.html2canvas);
		if (h2cPromise) return h2cPromise;
		h2cPromise = new Promise(function (resolve, reject) {
			var s = document.createElement('script');
			s.src = H2C_CDN;
			s.async = true;
			s.onload = function () {
				if (window.html2canvas) resolve(window.html2canvas);
				else reject(new Error('html2canvas missing'));
			};
			s.onerror = function () { reject(new Error('html2canvas failed')); };
			document.head.appendChild(s);
		});
		return h2cPromise;
	}

	function fontsReady() {
		if (document.fonts && document.fonts.ready) {
			return document.fonts.ready.catch(noop);
		}
		return Promise.resolve();
	}

	function delay(ms) {
		return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
	}

	/* --------------------------------------------------------- the snapshot */

	function snapshot() {
		return {
			x: window.scrollX,
			y: window.scrollY,
			w: window.innerWidth,
			h: window.innerHeight
		};
	}

	// The whole page lives in base.html's .ui.text.container. Capture that
	// column, cropped to the part the reader can actually see.
	function pageRoot() {
		return document.querySelector('.ui.text.container') ||
			document.querySelector('.comprehensive-div') ||
			document.body;
	}

	function capture() {
		var el = pageRoot();
		if (!el || el.getClientRects().length === 0) return Promise.resolve(null);

		var r = el.getBoundingClientRect();
		var top = Math.max(0, r.top);
		var bottom = Math.min(window.innerHeight, r.bottom);
		var left = Math.max(0, r.left);
		var right = Math.min(window.innerWidth, r.right);
		var width = right - left;
		var height = bottom - top;
		if (width < 4 || height < 4) return Promise.resolve(null);

		return loadHtml2Canvas().then(function (h2c) {
			return h2c(el, {
				scale: SCALE,
				backgroundColor: isDark() ? '#1b1c1d' : '#ffffff',
				useCORS: true,
				logging: false,
				x: left - r.left,
				y: top - r.top,
				width: width,
				height: height,
				windowWidth: window.innerWidth,
				windowHeight: window.innerHeight,
				scrollX: 0,
				scrollY: 0
			});
		});
	}

	/* ------------------------------------------------------------- compose */

	function compose(canvas, payload) {
		return new Promise(function (resolve) {
			var pad = PAD * SCALE;
			var band = BAND * SCALE;
			var w = canvas.width + pad * 2;
			var h = canvas.height + pad * 2 + band;
			var out = document.createElement('canvas');
			out.width = w;
			out.height = h;
			var ctx = out.getContext('2d');
			var dark = isDark();

			ctx.fillStyle = dark ? '#1b1c1d' : '#ffffff';
			ctx.fillRect(0, 0, w, h);
			ctx.drawImage(canvas, pad, pad);

			// Brand band: the site name, then the full page URL under it.
			ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
			ctx.fillRect(0, h - band, w, band);
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';

			ctx.fillStyle = dark ? 'rgba(255,255,255,.86)' : 'rgba(0,0,0,.72)';
			ctx.font = '600 ' + (14 * SCALE) + "px 'Open Sans', system-ui, sans-serif";
			ctx.fillText('aayatun.com', w / 2, h - band + band * 0.36);

			var label = String(payload.url || '');
			var size = 10.5 * SCALE;
			var maxW = w - pad * 2;
			ctx.fillStyle = dark ? 'rgba(255,255,255,.58)' : 'rgba(0,0,0,.46)';
			ctx.font = '400 ' + size + "px 'Open Sans', system-ui, sans-serif";
			while (label && ctx.measureText(label).width > maxW && size > 8 * SCALE) {
				size -= SCALE * 0.5;
				ctx.font = '400 ' + size + "px 'Open Sans', system-ui, sans-serif";
			}
			ctx.fillText(label, w / 2, h - band + band * 0.72);

			out.toBlob(function (blob) {
				if (!blob) { resolve(null); return; }
				resolve(new File([blob], 'aayatun-' + (payload.ref || 'share') + '.png',
					{ type: 'image/png' }));
			}, 'image/png');
		});
	}

	/* --------------------------------------------------------------- cache */

	function cacheKey(payload) {
		return payload.kind + '|' + payload.ref + '|' + (isDark() ? 'd' : 'l');
	}

	function cachePut(key, promise) {
		cache[key] = promise;
		cacheOrder.push(key);
		while (cacheOrder.length > CACHE_MAX) {
			var old = cacheOrder.shift();
			if (old !== key) {
				delete cache[old];
				delete ready[old];
			}
		}
		promise.then(function (entry) {
			if (entry && entry.file) ready[key] = entry;
		});
	}

	function isStale(key) {
		var entry = ready[key];
		if (!entry || !entry.shot) return true;
		var s = entry.shot;
		return s.x !== window.scrollX || s.y !== window.scrollY ||
			s.w !== window.innerWidth || s.h !== window.innerHeight;
	}

	function prepare(payload) {
		if (!payload) return Promise.resolve(null);
		var key = cacheKey(payload);
		if (!cache[key]) {
			var shot = snapshot();
			var promise = fontsReady().then(function () {
				// Let DataTables finish repaginating and the page settle.
				return delay(350);
			}).then(function () {
				shot = snapshot();
				return capture();
			}).then(function (canvas) {
				if (!canvas) return null;
				return compose(canvas, payload);
			}).then(function (file) {
				return file ? { file: file, shot: shot } : null;
			}).catch(function () {
				return null;
			});
			cachePut(key, promise);
		}
		return cache[key].then(function (entry) {
			return entry ? entry.file : null;
		});
	}

	// Rebuild an image that no longer matches the viewport (scrolled, resized,
	// table repaginated). Pending builds are left alone.
	function refresh(payload) {
		if (!payload) return;
		var key = cacheKey(payload);
		if (ready[key] && isStale(key)) {
			delete cache[key];
			delete ready[key];
		}
		prepare(payload).catch(noop);
	}

	function scheduleWarm() {
		if (scrollTimer) window.clearTimeout(scrollTimer);
		scrollTimer = window.setTimeout(function () {
			refresh(activePayload);
		}, 450);
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

	// Desktop browsers usually cannot attach files to the share sheet, so the
	// PNG is saved next to the copied text instead of being silently dropped.
	function saveImage(file, payload) {
		if (!file) return;
		try {
			var url = URL.createObjectURL(file);
			var a = document.createElement('a');
			a.href = url;
			a.download = file.name || ('aayatun-' + (payload.ref || 'share') + '.png');
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
		} catch (e) {}
	}

	function fallbackShare(err, payload, btn) {
		if (err && err.name === 'AbortError') return Promise.resolve();
		// A failed share gets one text-only attempt, then the clipboard.
		if (navigator.share) {
			return navigator.share({ title: payload.title, text: payload.text })
				.catch(function (err2) {
					if (err2 && err2.name === 'AbortError') return;
					return copyText(payload.text, btn);
				});
		}
		return copyText(payload.text, btn);
	}

	function shareWithFile(payload, file, btn) {
		return navigator.share({ title: payload.title, text: payload.text, files: [file] })
			.catch(function (err) { return fallbackShare(err, payload, btn); });
	}

	function share(payload, btn) {
		if (!payload) return Promise.resolve();
		var key = cacheKey(payload);
		var entry = ready[key];
		var filesOK = canShareFiles();

		// Fast path: a current image is ready, stay inside the tap (Safari).
		if (filesOK && entry && !isStale(key) && navigator.canShare({ files: [entry.file] })) {
			return shareWithFile(payload, entry.file, btn);
		}

		if (filesOK) {
			// iOS loses the user activation across an await, so use whatever
			// was warmed (even if the reader scrolled) instead of text.
			if (isIOSSafari() && entry && navigator.canShare({ files: [entry.file] })) {
				prepare(payload).catch(noop);
				return shareWithFile(payload, entry.file, btn);
			}
			if (btn) btn.classList.add('loading');
			return prepare(payload).then(function (file) {
				if (btn) btn.classList.remove('loading');
				if (file && navigator.canShare({ files: [file] })) {
					return shareWithFile(payload, file, btn);
				}
				return fallbackShare(null, payload, btn);
			}, function () {
				if (btn) btn.classList.remove('loading');
				return fallbackShare(null, payload, btn);
			});
		}

		// No file sharing: save the PNG and copy the text, so the image is
		// still produced on every page.
		return prepare(payload).then(function (file) {
			saveImage(file, payload);
			return copyText(payload.text, btn);
		}, function () {
			return copyText(payload.text, btn);
		});
	}

	function fromButton(btn) {
		return share(payloadFromButton(btn), btn);
	}

	function shareVerse(v) {
		var payload = versePayload(v);
		activePayload = payload;
		return share(payload, byId('share-btn'));
	}

	function registerVerse(v) {
		var payload = versePayload(v);
		activePayload = payload;
		// The carousel applies verses quickly; debounce so a fast swipe does
		// not start several html2canvas runs. Keep older entries in the LRU
		// instead of wiping them, so a tap right after a swipe has an image.
		if (verseTimer) window.clearTimeout(verseTimer);
		verseTimer = window.setTimeout(function () {
			prepare(payload).catch(noop);
		}, 350);
	}

	/* ---------------------------------------------------------------- init */

	document.addEventListener('DOMContentLoaded', function () {
		var buttons = document.querySelectorAll('.aayatun-share-btn');
		for (var i = 0; i < buttons.length; i++) {
			var payload = payloadFromButton(buttons[i]);
			if (payload) allPayloads.push(payload);
		}
		if (allPayloads.length) activePayload = allPayloads[0];
		// Warm after the page has painted (DataTables paginates in a timeout).
		window.setTimeout(function () {
			refresh(allPayloads[0]);
			loadHtml2Canvas().catch(noop);
		}, 900);

		// The image is viewport-sized, so keep it in step with scrolling and
		// rotation. Debounced: a capture of a long surah table is not cheap.
		window.addEventListener('scroll', scheduleWarm, { passive: true });
		window.addEventListener('resize', scheduleWarm);
		window.addEventListener('orientationchange', scheduleWarm);

		if (window.jQuery) {
			window.jQuery(document).on('draw.dt', scheduleWarm);
		}
	});

	window.AayatunShare = {
		fromButton: fromButton,
		shareVerse: shareVerse,
		registerVerse: registerVerse,
		prepare: prepare,
		payloadFromButton: payloadFromButton
	};
})();
