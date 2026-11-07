/*
 * Native sharing for Aayatun's reading views.
 *
 * One module builds the social-media text for every view (verse, whole surah,
 * printed mushaf page), calls the Web Share API when available, and falls back
 * to copying the formatted text. When the browser can share files, it also
 * attaches a PNG of the content: the page is captured with html2canvas (loaded
 * on demand), the pieces are composed on a themed card and a small
 * "aayatun.com · #aayatun" band is drawn at the bottom.
 *
 * The image is prepared ahead of the tap where possible: Safari requires
 * navigator.share() to run inside the user gesture, so waiting for html2canvas
 * after the click would lose the activation. If the image is not ready yet it
 * is built on demand and the share falls back to text (then clipboard).
 */
(function () {
	'use strict';

	var HASHTAG = '#aayatun';
	var BRAND = 'aayatun.com · #aayatun';
	var H2C_CDN = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
	var SCALE = 2;
	var MAX_HEIGHT = 2600;   // CSS px of content before the capture is cropped
	var PAD = 20;            // CSS px of card padding
	var BAND = 56;           // CSS px of branding band
	var CACHE_MAX = 2;

	var cache = {};
	var cacheOrder = [];
	var ready = {};   // key -> finished File, so a share can stay inside the tap
	var h2cPromise = null;
	var verseTimer = null;

	var VIEW_LABEL = {
		arabic: 'Arabic text with translation',
		translation: 'English translation',
		'tafsir-en': "Ibn Kathir's tafsir",
		'tafsir-bn': 'Bangla tafsir (Abu Bakr Zakaria)'
	};

	var TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

	function byId(id) { return document.getElementById(id); }
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
			targets: ['#ayah', '#verse-translation']
		};
	}

	function payloadFromButton(btn) {
		var d = btn.dataset || {};
		var kind = d.shareKind;
		if (!kind) return null;
		var payload = {
			kind: kind,
			url: d.shareUrl || window.location.href,
			ref: d.shareRef || kind,
			targets: (d.shareTarget || '').split('|').filter(Boolean)
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
			return document.fonts.ready.catch(function () {});
		}
		return Promise.resolve();
	}

	function capture(selector) {
		var el = document.querySelector(selector);
		if (!el || el.getClientRects().length === 0) return Promise.resolve(null);
		var full = el.scrollHeight || el.getBoundingClientRect().height;
		var height = Math.min(full, MAX_HEIGHT);
		return loadHtml2Canvas().then(function (h2c) {
			return h2c(el, {
				scale: SCALE,
				backgroundColor: null,
				useCORS: true,
				logging: false,
				height: height
			});
		}).then(function (canvas) {
			return {
				canvas: canvas,
				cropped: full > height + 1
			};
		});
	}

	function compose(parts, payload) {
		return new Promise(function (resolve) {
			var pad = PAD * SCALE;
			var band = BAND * SCALE;
			var width = 0;
			var content = 0;
			parts.forEach(function (p) {
				width = Math.max(width, p.canvas.width);
				content += p.canvas.height;
			});
			var gap = parts.length > 1 ? pad : 0;
			var w = width + pad * 2;
			var h = content + gap * (parts.length - 1) + pad * 2 + band;
			var canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			var ctx = canvas.getContext('2d');
			ctx.fillStyle = isDark() ? '#1b1c1d' : '#ffffff';
			ctx.fillRect(0, 0, w, h);

			var y = pad;
			parts.forEach(function (p) {
				ctx.drawImage(p.canvas, Math.round((w - p.canvas.width) / 2), y);
				y += p.canvas.height + gap;
			});

			ctx.fillStyle = isDark() ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)';
			ctx.fillRect(0, h - band, w, band);
			ctx.fillStyle = isDark() ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.48)';
			ctx.font = '600 ' + (15 * SCALE) + "px 'Open Sans', system-ui, sans-serif";
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			var label = BRAND;
			if (parts.some(function (p) { return p.cropped; })) {
				label = 'Continue at ' + String(payload.url).replace(/^https?:\/\//, '') +
					'  ·  ' + HASHTAG;
			}
			ctx.fillText(label, w / 2, h - band / 2);

			canvas.toBlob(function (blob) {
				if (!blob) { resolve(null); return; }
				resolve(new File([blob], 'aayatun-' + (payload.ref || 'share') + '.png',
					{ type: 'image/png' }));
			}, 'image/png');
		});
	}

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
		promise.then(function (file) {
			if (file) ready[key] = file;
		});
	}

	function delay(ms) {
		return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
	}

	function prepare(payload) {
		if (!payload || !canShareFiles() || navigator.onLine === false) {
			return Promise.resolve(null);
		}
		var key = cacheKey(payload);
		if (cache[key]) return cache[key];
		var promise = fontsReady().then(function () {
			// Let DataTables finish paginating (its init runs in a timeout
			// after DOMContentLoaded) so the shot is the visible page, not
			// the whole surah table.
			return delay(500);
		}).then(function () {
			return Promise.all(payload.targets.map(capture));
		}).then(function (parts) {
			parts = parts.filter(Boolean);
			if (!parts.length) return null;
			return compose(parts, payload);
		}).catch(function () {
			return null;
		});
		cachePut(key, promise);
		return promise;
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

	function share(payload, btn) {
		if (!payload) return Promise.resolve();
		var file = ready[cacheKey(payload)];
		if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
			// Already built: stay inside the tap, which Safari requires.
			return navigator.share({ title: payload.title, text: payload.text, files: [file] })
				.catch(function (err) { return fallbackShare(err, payload, btn); });
		}
		// No image yet. Never await html2canvas inside the gesture (Safari
		// would drop the user activation and refuse the sheet); share the text
		// now and keep building the image in the background for the next tap.
		prepare(payload).catch(function () {});
		return fallbackShare(null, payload, btn);
	}

	function fromButton(btn) {
		return share(payloadFromButton(btn), btn);
	}

	function shareVerse(v) {
		var payload = versePayload(v);
		return share(payload, byId('share-btn'));
	}

	function registerVerse(v) {
		var payload = versePayload(v);
		// Only the current verse matters; drop any warmed older image so a
		// long reading session does not keep several PNGs in memory.
		cache = {};
		cacheOrder = [];
		ready = {};
		if (verseTimer) window.clearTimeout(verseTimer);
		if (!canShareFiles()) return;
		verseTimer = window.setTimeout(function () {
			prepare(payload);
		}, 1800);
	}

	/* ---------------------------------------------------------------- init */

	document.addEventListener('DOMContentLoaded', function () {
		var buttons = document.querySelectorAll('.aayatun-share-btn[data-share-target]');
		if (!canShareFiles()) return;
		// After DataTables has paginated and the first paint has settled, not
		// on the DOMContentLoaded tick (the table is still the full surah then).
		window.setTimeout(function () {
			for (var i = 0; i < buttons.length; i++) {
				(function (btn) {
					var payload = payloadFromButton(btn);
					if (payload) prepare(payload);
				})(buttons[i]);
			}
		}, 1200);
	});

	window.AayatunShare = {
		fromButton: fromButton,
		shareVerse: shareVerse,
		registerVerse: registerVerse,
		prepare: prepare,
		payloadFromButton: payloadFromButton
	};
})();
