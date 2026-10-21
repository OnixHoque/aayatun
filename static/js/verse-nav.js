/*
 * Verse page client-side navigation.
 *
 * The page is still rendered server-side on first load (SEO, share links,
 * no-JS, iframes). This module only replaces next/prev full-page reloads with
 * a small JSON fetch + DOM update, and lazily fetches accordion sections.
 * If anything fails — missing fetch, stale token, network down — it falls
 * back to a normal navigation so the site keeps working.
 */
(function () {
	'use strict';

	var meta = document.querySelector('meta[name="aayatun-api-token"]');
	var content = document.getElementById('pagecontent');
	if (!content || !meta || !window.fetch || !window.history || !history.pushState) return;

	var TOKEN = meta.getAttribute('content') || '';
	var API = '/api/v1/verse/';
	var sections = document.getElementById('verse-sections');
	// Only these have API endpoints; "grammar" is static (just a link).
	var LAZY = { ai: 1, wfw: 1, defs: 1, morph: 1, bn: 1, en: 1 };

	function toInt(v) { return parseInt(v, 10) || 0; }
	function pair(s, v) {
		s = toInt(s); v = toInt(v);
		return s && v ? [s, v] : null;
	}
	function byId(id) { return document.getElementById(id); }

	var state = {
		surah: toInt(content.getAttribute('data-surah')),
		verse: toInt(content.getAttribute('data-verse')),
		prev: pair(content.getAttribute('data-prev-surah'), content.getAttribute('data-prev-verse')),
		next: pair(content.getAttribute('data-next-surah'), content.getAttribute('data-next-verse')),
		surahName: (byId('surah-name-label') || {}).textContent || '',
		// Kept separately: with tajweed ON the h1 holds QCF codepoints, which
		// must not be used for sharing.
		ayah: (byId('ayah-plain-src') || {}).textContent || '',
		translation: (byId('verse-translation') || {}).textContent || ''
	};

	/* ---------------------------------------------------------------- API */

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

	function apiFetch(path) {
		return fetch(path, {
			headers: { 'X-Aayatun-Token': TOKEN },
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
		fetchCore(p[0], p[1]).catch(function () {});
	}

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

	function applyVerse(d, dir) {
		// A modal open on the old verse (word details / related meanings)
		// must not survive the swap.
		if (window.jQuery) {
			jQuery('.ui.modal.visible').modal('hide');
		}

		var root = document.documentElement;
		root.classList.remove('nav-next', 'nav-prev');
		// Force a reflow so navigating the same direction twice re-runs it.
		void root.offsetWidth;
		if (dir === 'next' || dir === 'prev') {
			root.classList.add('nav-' + dir);
			var seq = ++animSeq;
			setTimeout(function () {
				if (seq === animSeq) root.classList.remove('nav-next', 'nav-prev');
			}, 450);
		}

		state.surah = d.surah;
		state.verse = d.verse;
		state.prev = d.prev;
		state.next = d.next;
		state.surahName = d.surah_name || state.surahName;
		state.ayah = d.ayah || '';
		state.translation = d.translation || '';

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

		var translation = byId('verse-translation');
		if (translation) translation.textContent = d.translation;

		// Keep the h1 hidden until the new page's font/markup is ready when
		// tajweed is persisted ON, so there is no plain -> coloured flash.
		var tajweedOn = false;
		try { tajweedOn = localStorage.getItem('ayahTajweedOn') === '1'; } catch (e) {}
		if (window.VerseTajweed && window.VerseTajweed.setData) {
			window.VerseTajweed.setData(d, tajweedOn);
		} else {
			var ayah = byId('ayah');
			if (ayah) ayah.textContent = d.ayah || '';
		}

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
	}

	/* ----------------------------------------------------------- navigation */

	var navSeq = 0;
	var pendingPush = false;
	var animSeq = 0;

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
			applyVerse(data, dir);
			if (push) {
				history.pushState({ surah: data.surah, verse: data.verse }, '',
					'/' + data.surah + '/' + data.verse);
			}
			prefetch(data.prev);
			prefetch(data.next);
			if (window.hideLoading) window.hideLoading();
		}).catch(function () {
			if (push) pendingPush = false;
			if (seq !== navSeq) return;
			// API unavailable / token stale: let the server render the page.
			window.location.href = '/' + surah + '/' + verse;
		});
	}

	function navigateDir(dir) {
		var p = dir === 'next' ? state.next : state.prev;
		if (!p) return;
		loadVerse(p[0], p[1], dir, true);
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
		loadVerse(target[0], target[1], dir === 'prev' ? 'prev' : (dir === 'next' ? 'next' : null), true);
		return false;
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
		var url = new URL('/' + state.surah + '/' + state.verse, window.location.origin).href;
		var text = state.ayah + '\n\n' + state.translation;
		var title = state.surahName + ' ' + state.surah + ':' + state.verse;

		if (navigator.share) {
			navigator.share({ title: title, text: text, url: url }).catch(function () {});
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(url).then(function () {
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

		audioSources = audioUrl(state.surah, state.verse);

		initAccordion();
		if (window.jQuery) jQuery('.ui.button.toggle').state();

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

		document.addEventListener('swiped-left', function () {
			if (window.navigation_allowed === false) return;
			navigateDir('next');
		});
		document.addEventListener('swiped-right', function () {
			if (window.navigation_allowed === false) return;
			navigateDir('prev');
		});

		window.addEventListener('popstate', function () {
			var target = parseVerse(window.location.pathname);
			if (!target) return;
			loadVerse(target[0], target[1], null, false);
		});

		if (window.requestIdleCallback) {
			requestIdleCallback(function () { prefetch(state.next); }, { timeout: 2500 });
		} else {
			setTimeout(function () { prefetch(state.next); }, 1500);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
