/*
 * Verse page client-side navigation.
 *
 * The page is still rendered server-side on first load (SEO, share links,
 * no-JS, iframes). After that, one request per surah caches the Arabic +
 * translation of every verse in memory, so next/prev (buttons, keyboard,
 * swipe) swap instantly and the carousel can show the incoming verse while
 * the finger is still moving.
 *
 * Accordion sections are fetched only when opened. If anything fails — no
 * fetch, stale token, network down — navigation falls back to the per-verse
 * API and then to a full page load, so the site always keeps working.
 */
(function () {
	'use strict';

	var meta = document.querySelector('meta[name="aayatun-api-token"]');
	var content = document.getElementById('pagecontent');
	if (!content || !meta || !window.fetch || !window.history || !history.pushState) return;

	var TOKEN = meta.getAttribute('content') || '';
	var API = '/api/v1/verse/';
	var SURAH_API = '/api/v1/surah/';
	var sections = document.getElementById('verse-sections');
	// Only these have API endpoints; "grammar" is static (just a link).
	var LAZY = { ai: 1, wfw: 1, defs: 1, morph: 1, bn: 1, en: 1 };

	var ayahViewport = document.getElementById('ayah-viewport');
	var ayahTrack = document.getElementById('ayah-track');
	var transViewport = document.getElementById('translation-viewport');
	var transTrack = document.getElementById('translation-track');

	function toInt(v) { return parseInt(v, 10) || 0; }
	function pair(s, v) {
		s = toInt(s); v = toInt(v);
		return s && v ? [s, v] : null;
	}
	function byId(id) { return document.getElementById(id); }
	function noop() {}

	var state = {
		surah: toInt(content.getAttribute('data-surah')),
		verse: toInt(content.getAttribute('data-verse')),
		prev: pair(content.getAttribute('data-prev-surah'), content.getAttribute('data-prev-verse')),
		next: pair(content.getAttribute('data-next-surah'), content.getAttribute('data-next-verse')),
		surahName: (byId('surah-name-label') || {}).textContent || '',
		// Kept separately: with tajweed ON the h1 holds QCF codepoints, which
		// must not be used for sharing.
		ayah: (byId('ayah-plain-src') || {}).textContent || '',
		translation: (byId('verse-translation') || {}).textContent || '',
		data: null
	};

	var holder = byId('ayah-codev2');
	var markupSrc = byId('ayah-markup-src');
	state.data = {
		surah: state.surah,
		verse: state.verse,
		surah_name: state.surahName,
		prev: state.prev,
		next: state.next,
		ayah: state.ayah,
		translation: state.translation,
		qcf_page: holder ? holder.getAttribute('data-page') : '',
		ayah_codev2: holder ? holder.getAttribute('data-text') : '',
		ayah_tajweed: markupSrc ? markupSrc.innerHTML : ''
	};

	/* ------------------------------------------------------- per-verse API */

	var cache = {};
	var cacheOrder = [];
	var inflight = {};

	function cacheSet(key, data) {
		if (!(key in cache)) cacheOrder.push(key);
		cache[key] = data;
		while (cacheOrder.length > 24) {
			var old = cacheOrder.shift();
			if (old !== key) delete cache[old];
		}
	}

	function apiFetch(path, headers) {
		return fetch(path, {
			headers: headers || { 'X-Aayatun-Token': TOKEN },
			credentials: 'same-origin',
			cache: 'no-store'
		}).then(function (r) {
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r;
		});
	}

	function fetchCore(surah, verse) {
		var key = surah + ':' + verse;
		if (cache[key]) return Promise.resolve(cache[key]);
		if (inflight[key]) return inflight[key];
		var p = apiFetch(API + surah + '/' + verse)
			.then(function (r) { return r.json(); })
			.then(function (data) {
				delete inflight[key];
				cacheSet(key, data);
				return data;
			}, function (err) {
				delete inflight[key];
				throw err;
			});
		inflight[key] = p;
		return p;
	}

	function prefetch(p) {
		if (!p || !p[0]) return;
		var key = p[0] + ':' + p[1];
		if (cache[key] || inflight[key]) return;
		fetchCore(p[0], p[1]).catch(noop);
	}

	/* -------------------------------------------------------- surah cache */

	// Memory only, as agreed: one request carries the whole surah and is
	// dropped when the tab closes. Three entries cover current + both edges.
	var surahCache = {};
	var surahOrder = [];
	var surahInflight = {};

	function touchSurah(n) {
		var i = surahOrder.indexOf(n);
		if (i >= 0) surahOrder.splice(i, 1);
		surahOrder.push(n);
		while (surahOrder.length > 3) {
			var old = surahOrder.shift();
			if (old !== n) delete surahCache[old];
		}
	}

	function ensureSurah(n) {
		n = toInt(n);
		if (!n || n < 1 || n > 114) return Promise.reject(new Error('bad surah'));
		if (surahCache[n]) {
			touchSurah(n);
			return Promise.resolve(surahCache[n]);
		}
		if (surahInflight[n]) return surahInflight[n];
		var p = fetch(SURAH_API + n, { credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) throw new Error('HTTP ' + r.status);
				return r.json();
			})
			.then(function (payload) {
				delete surahInflight[n];
				if (!payload || !payload.verses) throw new Error('bad payload');
				surahCache[n] = payload;
				touchSurah(n);
				return payload;
			}, function (err) {
				delete surahInflight[n];
				throw err;
			});
		surahInflight[n] = p;
		return p;
	}

	function verseFromPayload(p, verse) {
		var v = p && p.verses && p.verses[verse - 1];
		if (!v) return null;
		return {
			surah: p.surah,
			verse: verse,
			surah_name: p.name,
			prev: verse > 1 ? [p.surah, verse - 1] : p.prev,
			next: verse < p.count ? [p.surah, verse + 1] : p.next,
			ayah: v[0],
			translation: v[1],
			qcf_page: v[2],
			ayah_codev2: v[3]
		};
	}

	// Resolve a verse from whatever is already in memory (never triggers a
	// request), so the carousel can paint synchronously.
	function dataFor(surah, verse) {
		if (state.data && state.data.surah === surah && state.data.verse === verse)
			return state.data;
		var payload = surahCache[surah];
		if (payload) {
			var d = verseFromPayload(payload, verse);
			if (d) return d;
		}
		return cache[surah + ':' + verse] || offlineGet(surah, verse) || null;
	}

	/* ---------------------------------------------------- offline verse store */
	// The surah payload stays memory-only, but every verse actually shown is
	// kept in localStorage (bounded) so the page still renders its Arabic and
	// translation without a connection — including swipes to verses already
	// visited. Entries are plain data, not the surah payload.
	var OFFLINE_KEY = 'aayatun_verse_offline_v1';
	var OFFLINE_MAX = 60;
	var offlineMem = null;

	function offlineLoad() {
		if (offlineMem) return offlineMem;
		offlineMem = {};
		try {
			var list = JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]');
			for (var i = 0; i < list.length; i++) {
				var d = list[i];
				if (d && d.surah && d.verse) offlineMem[d.surah + ':' + d.verse] = d;
			}
		} catch (e) { offlineMem = {}; }
		return offlineMem;
	}

	function offlineGet(surah, verse) {
		return offlineLoad()[surah + ':' + verse] || null;
	}

	function offlinePut(d) {
		if (!d || !d.surah || !d.verse || !d.ayah) return;
		var o = offlineLoad();
		o[d.surah + ':' + d.verse] = {
			surah: d.surah,
			verse: d.verse,
			surah_name: d.surah_name || '',
			prev: d.prev || null,
			next: d.next || null,
			ayah: d.ayah,
			translation: d.translation || '',
			qcf_page: d.qcf_page || null,
			ayah_codev2: d.ayah_codev2 || '',
			t: Date.now()
		};
		var keys = Object.keys(o);
		if (keys.length > OFFLINE_MAX) {
			keys.sort(function (a, b) { return (o[a].t || 0) - (o[b].t || 0); });
			for (var i = 0; i < keys.length - OFFLINE_MAX; i++) delete o[keys[i]];
		}
		try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(o)); } catch (e) {}
	}

	function targetFor(dir) {
		// While a slide is in flight, state still points at the verse we are
		// leaving, so resolve repeats from the pending target instead.
		if (animating && pendingSlide && pendingSlide.dir === dir) {
			return dir === 'next' ? pendingSlide.data.next : pendingSlide.data.prev;
		}
		return dir === 'next' ? state.next : state.prev;
	}

	function neighbourData(dir) {
		var p = targetFor(dir);
		return p ? dataFor(p[0], p[1]) : null;
	}

	/* ------------------------------------------------------------- theme */

	// base.html applies the dark theme with one-off jQuery classes on page
	// load, so HTML injected later (lazy sections, related-meaning modals)
	// would keep Fomantic's light table/message/modal styling. Re-apply the
	// relevant rules to the new subtree only. Theme changes reload the page,
	// so only the theme active at injection time matters.
	function themeInjected(root) {
		if (!window.jQuery || !root) return;
		if (!document.documentElement.classList.contains('dark-theme')) return;
		var $el = jQuery(root);
		function pick(sel) { return $el.find(sel).addBack(sel); }
		pick('.segment').addClass('inverted');
		pick('.dropdown').addClass('inverted');
		pick('.button').addClass('inverted');
		pick('.table').addClass('inverted');
		pick('.icon').addClass('inverted');
		pick('.input').addClass('inverted transparent')
			.css('border-bottom', '1px solid rgba(33, 184, 255, 0.3)');
		pick('.selection').addClass('inverted');
		pick('.divider').addClass('inverted');
		pick('.loader').addClass('inverted');
		pick('.message').addClass('inverted')
			.css('border', '1px solid rgba(64,64,64, 0.5)')
			.css('border-radius', '5px')
			.css('background-color', 'rgba(30,30,30, 1)');
		pick('.modal').addClass('inverted')
			.css('border', '1px solid rgba(64,64,64, 0.5)')
			.css('border-radius', '5px');
	}

	function ensureSection(name) {
		if (!sections) return Promise.resolve(null);
		var el = sections.querySelector('.content[data-section="' + name + '"]');
		if (!el) return Promise.resolve(null);
		if (el.getAttribute('data-loaded') === '1') return Promise.resolve(el);
		if (el._loadPromise) return el._loadPromise;

		var forVerse = state.surah + ':' + state.verse;
		el.innerHTML = '<div class="ui active centered inline loader" style="margin: 24px auto;"></div>';
		themeInjected(el);
		el._loadPromise = apiFetch(API + state.surah + '/' + state.verse + '/' + name)
			.then(function (r) { return r.text(); })
			.then(function (html) {
				el._loadPromise = null;
				// A navigation may have happened while this was in flight.
				if (forVerse !== state.surah + ':' + state.verse) return null;
				el.innerHTML = html;
				el.setAttribute('data-loaded', '1');
				themeInjected(el);
				return el;
			}, function () {
				el._loadPromise = null;
				el.innerHTML = '<p style="text-align: center; padding: 16px;">Could not load this section. ' +
					'<a href="#" data-section-retry="' + name + '">Retry</a></p>';
				return null;
			});
		return el._loadPromise;
	}

	/* ----------------------------------------------------------- rendering */

	function setArrow(id, p) {
		var el = byId(id);
		if (el && p) el.href = '/' + p[0] + '/' + p[1];
	}

	var audioSources = [null, null];
	var audioIndex = 0;

	function audioUrl(surah, verse) {
		var p = ('00' + surah).slice(-3) + ('00' + verse).slice(-3);
		return [
			'http://www.everyayah.com/data/Alafasy_128kbps/' + p + '.mp3',
			'http://www.everyayah.com/data/Husary_128kbps_Mujawwad/' + p + '.mp3'
		];
	}

	function setAudio(surah, verse) {
		audioSources = audioUrl(surah, verse);
		audioIndex = 0;
		var audios = document.querySelectorAll('#audio-box audio');
		for (var i = 0; i < audios.length; i++) {
			try { audios[i].pause(); } catch (e) {}
			try { audios[i].currentTime = 0; } catch (e) {}
		}
		if (audios[0]) audios[0].src = audioSources[0];
		if (audios[1]) audios[1].src = audioSources[1];
	}

	function changeAudioSrc() {
		var audios = document.querySelectorAll('#audio-box audio');
		if (!audios.length || !audioSources[0]) return;
		audioIndex = (audioIndex + 1) % 2;
		audios[0].src = audioSources[audioIndex];
		audios[0].play();
	}

	function collapseAll() {
		if (window.jQuery) {
			var acc = jQuery('#verse-sections');
			if (acc.length) {
				try {
					acc.find('.title').each(function (i) { acc.accordion('close', i); });
				} catch (e) {}
			}
			var btn = byId('collapse-btn');
			if (btn) jQuery(btn).fadeOut();
		}
	}

	function resetSections() {
		if (!sections) return;
		var bodies = sections.querySelectorAll('.content[data-section]');
		for (var i = 0; i < bodies.length; i++) {
			var name = bodies[i].getAttribute('data-section');
			if (!LAZY[name]) continue;
			bodies[i].setAttribute('data-loaded', '0');
			bodies[i]._loadPromise = null;
			bodies[i].innerHTML = '<div class="ui active centered inline loader" style="margin: 24px auto;"></div>';
			themeInjected(bodies[i]);
		}
		collapseAll();
	}

	/* ------------------------------------------------------------ carousel */

	function pane(viewport, rel) {
		return viewport ? viewport.querySelector('[data-rel="' + rel + '"]') : null;
	}
	function currentPane(viewport) {
		return viewport ? viewport.querySelector('.is-current') : null;
	}
	function paneAyah(viewport, rel) {
		var p = pane(viewport, rel);
		return p ? p.querySelector('.ayah-text') : null;
	}
	function paneTranslation(viewport, rel) {
		var p = pane(viewport, rel);
		return p ? p.querySelector('p') : null;
	}
	function currentAyah() {
		var h = paneAyah(ayahViewport, 'current');
		return h || byId('ayah');
	}

	function trackWidth() {
		return ayahViewport ? ayahViewport.clientWidth : 0;
	}

	// dx is relative to the centred current pane: 0 = current, -width = next,
	// +width = previous.
	function setDx(dx, animate) {
		var w = trackWidth();
		var transform = 'translate3d(' + (-w + dx) + 'px, 0, 0)';
		if (ayahTrack) {
			ayahTrack.classList.toggle('is-settling', !!animate);
			ayahTrack.style.transform = transform;
		}
		if (transTrack) {
			transTrack.classList.toggle('is-settling', !!animate);
			transTrack.style.transform = transform;
		}
	}

	function recenter() {
		setDx(0, false);
	}

	function syncHeight() {
		if (ayahViewport) {
			var ap = currentPane(ayahViewport);
			if (ap) ayahViewport.style.height = Math.ceil(ap.offsetHeight) + 'px';
		}
		if (transViewport) {
			var tp = currentPane(transViewport);
			if (tp) transViewport.style.height = Math.ceil(tp.offsetHeight) + 'px';
		}
	}

	// Paint one Arabic pane, upgrading the markup fallback when the browser
	// has no font-palette support (the surah payload only carries code_v2).
	function paintAyahPane(viewport, rel, data) {
		var el = paneAyah(viewport, rel);
		var wrap = pane(viewport, rel);
		if (!el || !wrap) return;
		if (!data) {
			wrap.setAttribute('data-key', '');
			el.textContent = '';
			return;
		}
		wrap.setAttribute('data-key', data.surah + ':' + data.verse);
		var vt = window.VerseTajweed;
		if (!vt) { el.textContent = data.ayah || ''; return; }

		var needsMarkup = vt.isOn && vt.isOn() && vt.supportsFont &&
			!vt.supportsFont() && !data.ayah_tajweed;
		vt.renderInto(el, data);
		if (needsMarkup) {
			fetchCore(data.surah, data.verse).then(function (full) {
				if (wrap.getAttribute('data-key') !== data.surah + ':' + data.verse) return;
				if (full && full.ayah_tajweed) vt.renderInto(el, full);
			}).catch(noop);
		}
	}

	function paint() {
		var prev = neighbourData('prev');
		var next = neighbourData('next');

		paintAyahPane(ayahViewport, 'prev', prev);
		paintAyahPane(ayahViewport, 'next', next);

		var tp = paneTranslation(transViewport, 'prev');
		if (tp) tp.textContent = prev ? prev.translation : '';
		var tn = paneTranslation(transViewport, 'next');
		if (tn) tn.textContent = next ? next.translation : '';

		preloadPages();

		syncHeight();
	}

	// Fetch the next/prev three archives' page fonts ahead of the swipe, not
	// just the adjacent pane: fast swipes cross several pages, and each page
	// font is a separate ~78 KB request.
	function preloadPages() {
		var vt = window.VerseTajweed;
		if (!vt || !vt.preloadPage) return;
		var wanted = [];
		var payload = surahCache[state.surah];
		var base = state.verse;
		if (animating && pendingSlide && pendingSlide.data) {
			base = pendingSlide.data.verse;
			payload = surahCache[pendingSlide.data.surah] || payload;
		}
		if (payload && payload.verses) {
			for (var d = -3; d <= 3; d++) {
				if (!d) continue;
				var v = payload.verses[base - 1 + d];
				if (v && v[2]) wanted.push(v[2]);
			}
		}
		var prev = neighbourData('prev');
		var next = neighbourData('next');
		if (prev && prev.qcf_page) wanted.push(prev.qcf_page);
		if (next && next.qcf_page) wanted.push(next.qcf_page);
		var seen = {};
		for (var i = 0; i < wanted.length; i++) {
			var page = wanted[i];
			if (seen[page]) continue;
			seen[page] = 1;
			vt.preloadPage(page);
		}
	}

	function renderCurrent(d) {
		var vt = window.VerseTajweed;
		if (!vt || !vt.setData) {
			var h = currentAyah();
			if (h) h.textContent = d.ayah || '';
			return;
		}
		vt.setData(d, false);

		// Old browsers without font-palette need the coloured markup, which
		// only the per-verse endpoint carries.
		if (vt.isOn && vt.isOn() && vt.supportsFont && !vt.supportsFont() &&
			!d.ayah_tajweed) {
			var key = d.surah + ':' + d.verse;
			fetchCore(d.surah, d.verse).then(function (full) {
				if (state.surah + ':' + state.verse !== key) return;
				if (full && full.ayah_tajweed) vt.setData(full, false);
				syncHeight();
			}).catch(noop);
		}
	}

	function applyVerse(d, dir) {
		// Arrow links go through the base template's click capture, which
		// shows the bar before we get here. Make sure it never sticks.
		if (window.hideLoading) window.hideLoading();
		// A modal open on the old verse (word details / related meanings)
		// must not survive the swap.
		if (window.jQuery) {
			jQuery('.ui.modal.visible').modal('hide');
		}

		state.data = d;
		state.surah = d.surah;
		state.verse = d.verse;
		state.prev = d.prev;
		state.next = d.next;
		state.surahName = d.surah_name || state.surahName;
		state.ayah = d.ayah || '';
		state.translation = d.translation || '';
		offlinePut(d);

		content.setAttribute('data-surah', d.surah);
		content.setAttribute('data-verse', d.verse);
		content.setAttribute('data-prev-surah', d.prev ? d.prev[0] : '');
		content.setAttribute('data-prev-verse', d.prev ? d.prev[1] : '');
		content.setAttribute('data-next-surah', d.next ? d.next[0] : '');
		content.setAttribute('data-next-verse', d.next ? d.next[1] : '');
		var plainSrc = byId('ayah-plain-src');
		if (plainSrc) plainSrc.textContent = state.ayah;

		var link = byId('surah-verse-link');
		if (link) {
			link.href = '/' + d.surah + '/1';
			link.textContent = d.surah + ':' + d.verse;
		}
		var nameLabel = byId('surah-name-label');
		if (nameLabel) nameLabel.textContent = state.surahName;

		setArrow('prev-arrow', d.prev);
		setArrow('next-arrow', d.next);

		var translation = paneTranslation(transViewport, 'current') || byId('verse-translation');
		if (translation) translation.textContent = d.translation || '';

		renderCurrent(d);

		setAudio(d.surah, d.verse);
		resetSections();

		var corpus = byId('corpus-link');
		if (corpus) {
			corpus.href = 'http://corpus.quran.com/treebank.jsp?chapter=' + d.surah + '&verse=' + d.verse;
		}

		document.title = state.surahName + ' : Aayatun - An Ayah a Day';

		try {
			if (typeof setValues === 'function' && typeof pages !== 'undefined') {
				setValues(pages.VERSE_DETAILS, d.surah + ':' + d.verse);
			}
		} catch (e) {}

		window.scrollTo(0, 0);
		syncHeight();
		if (window.requestAnimationFrame) requestAnimationFrame(syncHeight);
	}

	// Make sure the current and neighbouring surahs have payloads, then
	// repaint once they arrive (the user may already be on that verse).
	function warmSurahs() {
		var here = state.surah;
		var wanted = [here];
		if (state.next && state.next[0] !== here) wanted.push(state.next[0]);
		if (state.prev && state.prev[0] !== here) wanted.push(state.prev[0]);
		for (var i = 0; i < wanted.length; i++) {
			(function (n) {
				if (!n) return;
				ensureSurah(n).then(function () {
					if (state.surah !== here) return;
					paint();
				}).catch(noop);
			})(wanted[i]);
		}
	}

	// Old browsers without font-palette only get tajweed from the coloured
	// markup, which the surah payload does not carry. Fetch it for the verse
	// on screen after the user turns tajweed on.
	function upgradeCurrentMarkup() {
		var vt = window.VerseTajweed;
		if (!vt || !vt.isOn || !vt.isOn() || !vt.supportsFont || vt.supportsFont()) return;
		var d = state.data;
		if (!d || d.ayah_tajweed) return;
		var key = state.surah + ':' + state.verse;
		fetchCore(state.surah, state.verse).then(function (full) {
			if (state.surah + ':' + state.verse !== key) return;
			if (!full || !full.ayah_tajweed) return;
			state.data.ayah_tajweed = full.ayah_tajweed;
			vt.setData(full, false);
			syncHeight();
		}).catch(noop);
	}

	/* ----------------------------------------------------------- navigation */

	var navSeq = 0;
	var pendingPush = false;
	var settleToken = 0;
	var animating = false;
	// Verse the in-flight slide is heading to. Arrow-key repeats target the
	// one after it instead of resolving from stale state (see targetFor).
	var pendingSlide = null;

	function parseVerse(url) {
		try {
			var path = new URL(url, window.location.origin).pathname;
			var m = /^\/(\d+)\/(\d+)\/?$/.exec(path);
			if (!m) return null;
			return [parseInt(m[1], 10), parseInt(m[2], 10)];
		} catch (e) {
			return null;
		}
	}

	function cancelSettle() {
		settleToken++;
		animating = false;
		pendingSlide = null;
		if (ayahTrack) ayahTrack.classList.remove('is-settling');
		if (transTrack) transTrack.classList.remove('is-settling');
		ayahViewport && ayahViewport.classList.remove('is-dragging');
		transViewport && transViewport.classList.remove('is-dragging');
	}

	function pushUrl(d) {
		history.pushState({ surah: d.surah, verse: d.verse }, '',
			'/' + d.surah + '/' + d.verse);
	}

	// Instantly move to a verse already in memory. Returns false when the
	// caller has to fall back to the per-verse endpoint. With animate=true the
	// track slides one pane first (arrow clicks / keyboard), same as a swipe.
	function commitTo(surah, verse, dir, push, animate) {
		var d = dataFor(surah, verse);
		if (!d) return false;
		// The base template's click capture already called showLoading() for
		// the arrow link; cancel it before anything paints.
		if (window.hideLoading) window.hideLoading();
		if (animate && dir && !reducedMotion) {
			// Make sure the incoming half already shows the target verse.
			paintAyahPane(ayahViewport, dir, d);
			var tp = paneTranslation(transViewport, dir);
			if (tp) tp.textContent = d.translation || '';
			slideTo(d, dir, push);
			return true;
		}
		cancelSettle();
		applyVerse(d, dir);
		recenter();
		paint();
		if (push) pushUrl(d);
		warmSurahs();
		return true;
	}

	// Slide the neighbour pane fully in, then swap the middle pane to it and
	// re-centre without a transition: the two frames are identical.
	function slideTo(d, dir, push) {
		cancelSettle();
		pendingSlide = { data: d, dir: dir };
		var w = trackWidth();
		setDx(dir === 'next' ? -w : w, true);
		animating = true;
		var seq = ++settleToken;
		setTimeout(function () {
			if (seq !== settleToken) return;
			animating = false;
			pendingSlide = null;
			applyVerse(d, dir);
			recenter();
			paint();
			if (push) pushUrl(d);
			warmSurahs();
			if (ayahTrack) ayahTrack.classList.remove('is-settling');
			if (transTrack) transTrack.classList.remove('is-settling');
		}, 225);
	}

	// Slow path: one small request (with the server-rendered page as the
	// final fallback). Used for popstate, surah edges and cache misses.
	function loadVerse(surah, verse, dir, push) {
		// Ignore rapid arrow/key repeats while a pointer-initiated nav is in
		// flight; popstate (push=false) is still allowed to win via navSeq.
		if (push && pendingPush) return;
		if (push) pendingPush = true;
		var seq = ++navSeq;
		if (window.showLoading) window.showLoading();
		fetchCore(surah, verse).then(function (data) {
			if (push) pendingPush = false;
			if (seq !== navSeq) return;
			cancelSettle();
			applyVerse(data, dir);
			recenter();
			paint();
			if (push) pushUrl(data);
			warmSurahs();
			if (window.hideLoading) window.hideLoading();
		}).catch(function () {
			if (push) pendingPush = false;
			if (seq !== navSeq) return;
			// Still within the persisted offline verses: show it instead of
			// leaving the reading position.
			var off = offlineGet(surah, verse);
			if (off) {
				cancelSettle();
				applyVerse(off, dir);
				recenter();
				paint();
				if (push) pushUrl(off);
				if (window.hideLoading) window.hideLoading();
				return;
			}
			// API unavailable / token stale: let the server render the page.
			window.location.href = '/' + surah + '/' + verse;
		});
	}

	function goTo(surah, verse, dir, push, animate) {
		if (commitTo(surah, verse, dir, push, animate)) return true;
		loadVerse(surah, verse, dir, push);
		return false;
	}

	function navigateDir(dir) {
		var p = targetFor(dir);
		if (!p) return;
		goTo(p[0], p[1], dir, true, true);
	}

	// Replaces the full-page fallback defined in the head script.
	function navigateVerse(url, dir, event) {
		if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
			(event.button && event.button !== 0))) return true;
		var target = parseVerse(url);
		if (!target) {
			if (window.showLoading) window.showLoading();
			window.location.href = url;
			return false;
		}
		goTo(target[0], target[1], dir === 'prev' ? 'prev' : (dir === 'next' ? 'next' : null), true, true);
		return false;
	}

	/* -------------------------------------------------------------- swipe */

	var reducedMotion = false;
	try {
		reducedMotion = !!(window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	} catch (e) {}

	var drag = null;

	function interactive(target) {
		if (!target || !target.closest) return true;
		return !!target.closest('a, button, input, textarea, select, audio, ' +
			'.title, .content, .modal, [name="word_index"], [name="root_index"]');
	}

	function onPointerDown(e) {
		if (window.navigation_allowed === false) return;
		if (reducedMotion || animating || drag) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (interactive(e.target)) return;

		drag = {
			id: e.pointerId,
			el: e.currentTarget,
			x: e.clientX,
			y: e.clientY,
			lastX: e.clientX,
			lastT: Date.now(),
			vx: 0,
			raw: 0,
			dx: 0,
			axis: 0   // 0 undecided, 1 horizontal, -1 vertical
		};
		// Get the payload ready while the finger is still down.
		ensureSurah(state.surah).then(function () {
			if (!drag) return;
			paint();
		}).catch(noop);
	}

	function onPointerMove(e) {
		if (!drag || e.pointerId !== drag.id) return;
		var dx = e.clientX - drag.x;
		var dy = e.clientY - drag.y;
		drag.raw = dx;

		if (!drag.axis) {
			if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
			if (Math.abs(dx) > Math.abs(dy) * 1.15) {
				drag.axis = 1;
				try { drag.el.setPointerCapture(e.pointerId); } catch (err) {}
				if (ayahViewport) ayahViewport.classList.add('is-dragging');
				if (transViewport) transViewport.classList.add('is-dragging');
			} else {
				drag.axis = -1;
				return;
			}
		}
		if (drag.axis !== 1) return;
		if (e.cancelable) e.preventDefault();

		var now = Date.now();
		if (now > drag.lastT) {
			drag.vx = (e.clientX - drag.lastX) / (now - drag.lastT);
			drag.lastX = e.clientX;
			drag.lastT = now;
		}

		var dir = dx < 0 ? 'next' : 'prev';
		var w = trackWidth();
		// Resist when the neighbour is not in memory yet; it usually arrives
		// within the same gesture (surah payload fetch).
		var eff = neighbourData(dir) ? dx : dx * 0.32;
		var limit = w * 1.05;
		if (eff > limit) eff = limit;
		if (eff < -limit) eff = -limit;
		drag.dx = eff;
		setDx(eff, false);
	}

	function onPointerUp(e) {
		if (!drag || e.pointerId !== drag.id) return;
		var d = drag;
		drag = null;
		if (ayahViewport) ayahViewport.classList.remove('is-dragging');
		if (transViewport) transViewport.classList.remove('is-dragging');

		if (d.axis !== 1) return;

		var w = trackWidth();
		var dir = d.dx < 0 ? 'next' : 'prev';
		var fast = Math.abs(d.vx) > 0.35 && ((d.vx < 0) === (dir === 'next'));
		var far = Math.abs(d.dx) > w * 0.25;
		var target = neighbourData(dir);

		if (!target || !(far || fast)) {
			setDx(0, true);
			settleToken++;
			var token = settleToken;
			setTimeout(function () {
				if (token !== settleToken) return;
				if (ayahTrack) ayahTrack.classList.remove('is-settling');
				if (transTrack) transTrack.classList.remove('is-settling');
			}, 240);
			return;
		}

		// Slide the neighbour pane fully in, then swap the middle pane to it
		// and re-centre without a transition: the two frames are identical.
		slideTo(target, dir, true);
	}

	function onPointerCancel(e) {
		if (!drag || e.pointerId !== drag.id) return;
		drag = null;
		if (ayahViewport) ayahViewport.classList.remove('is-dragging');
		if (transViewport) transViewport.classList.remove('is-dragging');
		setDx(0, true);
	}

	/* --------------------------------------------------------------- modals */

	function showDetails(heading, html) {
		if (!window.jQuery) return;
		jQuery('#word_details_modal_content').html(html);
		jQuery('#word_details_modal_heading').html(heading);
		themeInjected(byId('word_details_modal_content'));
		jQuery('#word_details_modal').modal('show');
		var c = byId('word_details_modal_content');
		if (c) c.scrollTop = 0;
	}

	function openWord(indexEl) {
		var words = document.getElementsByName('word_index');
		var i = Array.prototype.indexOf.call(words, indexEl);
		if (i < 0) return;
		ensureSection('morph').then(function () {
			var details = document.getElementsByName('word_details');
			if (!details[i]) return;
			showDetails('Morphological Details', details[i].outerHTML);
		});
	}

	function openRoot(indexEl) {
		var roots = document.getElementsByName('root_index');
		var i = Array.prototype.indexOf.call(roots, indexEl);
		if (i < 0) return;
		ensureSection('defs').then(function () {
			var defs = document.getElementsByName('root_details');
			if (!defs[i]) return;
			showDetails('Word Definition', defs[i].outerHTML);
		});
	}

	/* ---------------------------------------------------------------- share */

	function shareVerse() {
		if (window.AayatunShare) {
			window.AayatunShare.shareVerse({
				surah: state.surah,
				verse: state.verse,
				name: state.surahName,
				ayah: state.ayah,
				translation: state.translation
			});
			return;
		}
		// share.js failed to load: keep a plain native/clipboard path.
		var url = new URL('/' + state.surah + '/' + state.verse, window.location.origin).href;
		var name = String(state.surahName || '').replace(/\s*\([^)]*\)\s*$/, '');
		var text = name + ' ' + state.surah + ':' + state.verse + '\n\n' +
			state.translation + '\n\nRead on Aayatun: ' + url + '\n#aayatun';
		var title = name + ' ' + state.surah + ':' + state.verse;

		if (navigator.share) {
			navigator.share({ title: title, text: text }).catch(function () {});
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(text).then(function () {
				var b = byId('share-btn');
				if (!b) return;
				var old = b.innerHTML;
				b.innerHTML = '<i class="icon check"></i>';
				setTimeout(function () { b.innerHTML = old; }, 1200);
			});
		} else {
			window.prompt('Copy this link:', url);
		}
	}

	/* ----------------------------------------------------------------- init */

	function initAccordion() {
		if (!window.jQuery) return;
		var acc = jQuery('#verse-sections');
		if (!acc.length) return;
		acc.accordion({
			// Fomantic calls this with `this` bound to the content element and
			// no arguments (not with the title, as some docs suggest).
			onOpening: function () {
				var body = jQuery(this);
				var name = body.attr('data-section');
				if (!name || !LAZY[name]) return;
				// The word/root popups read their content from the morphology
				// and definitions sections. Fetch those alongside wfw so the
				// first word click is instant and never sees an empty section.
				if (name === 'wfw') {
					ensureSection('defs');
					ensureSection('morph');
				}
				if (body.attr('data-loaded') !== '1') ensureSection(name);
			},
			onOpen: function () {
				var b = byId('collapse-btn');
				if (b) b.style.display = '';
			}
		});
	}

	function init() {
		window.navigateVerse = navigateVerse;
		window.shareVerse = shareVerse;
		window.changeAudioSrc = changeAudioSrc;
		window.collapseAll = collapseAll;

		// Remember the verse first painted from the server response, so a
		// later refresh with no connection still has its Arabic + translation.
		offlinePut(state.data);

		audioSources = audioUrl(state.surah, state.verse);

		initAccordion();
		if (window.jQuery) jQuery('.ui.button.toggle').state();

		if (window.VerseTajweed && window.VerseTajweed.setRepaint) {
			window.VerseTajweed.setRepaint(function () {
				upgradeCurrentMarkup();
				paint();
			});
		}

		recenter();
		syncHeight();
		paint();

		['prev-arrow', 'next-arrow'].forEach(function (id) {
			var el = byId(id);
			if (!el) return;
			el.addEventListener('pointerenter', function () {
				prefetch(id === 'prev-arrow' ? state.prev : state.next);
			});
		});

		// One delegated handler survives every content swap.
		document.addEventListener('click', function (e) {
			var t = e.target;
			if (!t || !t.closest) return;

			var retry = t.closest('[data-section-retry]');
			if (retry) {
				e.preventDefault();
				ensureSection(retry.getAttribute('data-section-retry'));
				return;
			}
			var word = t.closest('[name="word_index"]');
			if (word) {
				e.preventDefault();
				openWord(word);
				return;
			}
			var root = t.closest('[name="root_index"]');
			if (root) {
				e.preventDefault();
				openRoot(root);
			}
		});

		document.addEventListener('keydown', function (event) {
			if (window.navigation_allowed === false) return;
			var code = event.keyCode || event.which;
			if (code !== 37 && code !== 39) return;
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
			var t = event.target;
			var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
			if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
			event.preventDefault();
			navigateDir(code === 37 ? 'prev' : 'next');
		});

		if (ayahViewport) {
			ayahViewport.addEventListener('pointerdown', onPointerDown);
			transViewport.addEventListener('pointerdown', onPointerDown);
			window.addEventListener('pointermove', onPointerMove, { passive: false });
			window.addEventListener('pointerup', onPointerUp);
			window.addEventListener('pointercancel', onPointerCancel);
		}

		window.addEventListener('popstate', function () {
			var target = parseVerse(window.location.pathname);
			if (!target) return;
			goTo(target[0], target[1], null, false, false);
		});

		window.addEventListener('resize', function () {
			recenter();
			syncHeight();
		});

		if (window.ResizeObserver) {
			var ro = new ResizeObserver(function () { syncHeight(); });
			var ap = currentPane(ayahViewport);
			var tp = currentPane(transViewport);
			if (ap) ro.observe(ap);
			if (tp) ro.observe(tp);
		}

		// The surah payload is the fast path; load it after first paint.
		if (window.requestIdleCallback) {
			requestIdleCallback(function () {
				warmSurahs();
				prefetch(state.next);
			}, { timeout: 2500 });
		} else {
			setTimeout(function () {
				warmSurahs();
				prefetch(state.next);
			}, 1200);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
