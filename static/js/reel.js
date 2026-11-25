(function () {
	'use strict';

	var initial = window.AAYATUN_REEL;
	if (!initial) return;

	var meta = document.querySelector('meta[name="aayatun-api-token"]');
	var TOKEN = meta ? meta.getAttribute('content') : '';
	var API = '/api/v1/reel/';
	var SLOW = 20 / 9; // 50% faster than previous (previous was 10/3)

	var stage = document.getElementById('reel-stage');
	var viewport = document.getElementById('reel-viewport');
	var track = document.getElementById('reel-track');
	var prevPane = document.getElementById('reel-pane-prev');
	var nextPane = document.getElementById('reel-pane-next');
	var verseBox = document.getElementById('reel-verse');
	var verseMeaning = document.getElementById('reel-verse-meaning');
	var actualTranslationEl = document.getElementById('reel-actual-translation');
	var refNum = document.getElementById('reel-ref-num');
	var wordAr = document.getElementById('reel-word-ar');
	var wordMeaning = document.getElementById('reel-word-meaning');
	var chipsEl = document.getElementById('reel-chips');
	var middleEl = document.querySelector('#reel-stage .reel-middle');
	var defRoot = document.getElementById('reel-def-root');
	var defSep = document.getElementById('reel-def-sep');
	var defText = document.getElementById('reel-def-text');
	var defLine = document.getElementById('reel-def-line');
	var morphCredit = document.getElementById('reel-morph-credit');
	var playBtn = document.getElementById('reel-play');
	var playIcon = document.getElementById('reel-play-icon');
	var prevPartBtn = document.getElementById('reel-prev-part');
	var nextPartBtn = document.getElementById('reel-next-part');
	var shareBtn = document.getElementById('reel-share');
	var shuffleBtn = document.getElementById('reel-shuffle');
	var closeBtn = document.getElementById('reel-close');
	var bottom = document.getElementById('reel-bottom');
	var endPanel = document.getElementById('reel-end-panel');
	var endScroll = document.getElementById('reel-end-scroll');
	var endContext = document.getElementById('reel-end-context');
	var endWm = document.getElementById('reel-end-wm');
	var endHint = document.getElementById('reel-end-hint');
	var hintOverlay = document.getElementById('reel-hint-overlay');
	var hintGotIt = document.getElementById('reel-hint-gotit');
	var progressEl = document.getElementById('reel-progress');
	var openingVerseEl = document.getElementById('reel-opening-verse');
	var openingTranslationEl = document.getElementById('reel-opening-translation');
	var HINT_KEY = 'aayatun_reel_hint_v1';
	var hintActive = false;
	var INITIAL_MS = ms(1000);

	var cache = {};
	var inflight = {};
	var state = {
		data: initial,
		idx: 0,
		playing: true,
		ended: false,
		phase: 'idle', // idle|intro|word|breakdown|rootmeaning|wordmeaning|fly|gap|end-context|end-words|end-done
		timer: null,
		flights: null,
		phaseStarted: 0,
		remaining: 0,
		// breakdown sequence
		breakdownIdx: 0,
		breakdownTotal: 0,
		// word meaning reveal substep
		wordmeaningStep: 0, // 0 waiting to show, 1 shown waiting to proceed
		// typewriter
		twText: '',
		twPos: 0,
		twTimer: null,
		twTarget: null,
		// end sequence
		endWmIdx: 0,
		endWmTotal: 0
	};

	var carousel = {
		animating: false,
		drag: null
	};

	var reduced = false;
	try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

	// Shuffle: one reel session keeps a linear back/forward history. Down at
	// history end picks an unseen verse (Surprise Me source: read map v2), else
	// any random verse; up goes back. Swipe up then down returns the same verse.
	var SHUFFLE_KEY = 'aayatun_reel_shuffle_v1';
	var shuffleOn = false;
	try {
		if (localStorage.getItem(SHUFFLE_KEY) === '1') shuffleOn = true;
	} catch (e) {}
	var shuffleHistory = []; // [[surah, verse], ...], session-only
	var shuffleCursor = -1;
	var shuffleNext = null; // pre-picked next verse when cursor is at history end

	function saveShuffle() {
		try { localStorage.setItem(SHUFFLE_KEY, shuffleOn ? '1' : '0'); } catch (e) {}
	}

	function syncShuffleBtn() {
		if (!shuffleBtn) return;
		shuffleBtn.classList.toggle('is-active', shuffleOn);
		shuffleBtn.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
		var label = shuffleOn ? 'Shuffle verses (on)' : 'Shuffle verses (off)';
		shuffleBtn.setAttribute('aria-label', label);
		shuffleBtn.setAttribute('title', label);
	}
	syncShuffleBtn();

	function verseFromIndex(idx) {
		var starts = window.AAYATUN_SURAH_STARTS;
		if (!Array.isArray(starts) || starts.length !== 114) return [1, 1];
		for (var s = 114; s >= 1; s--) {
			if (starts[s - 1] <= idx) return [s, idx - starts[s - 1] + 1];
		}
		return [1, 1];
	}

	function randomVerse(exclude) {
		var starts = window.AAYATUN_SURAH_STARTS || [];
		var total = 6236;
		if (starts.length > 1) total = starts[starts.length - 1];
		var exs = exclude && exclude[0] ? exclude[0] : 0;
		var exv = exclude && exclude[1] ? exclude[1] : 0;
		for (var tries = 0; tries < 12; tries++) {
			var n = Math.floor(Math.random() * total) + 1; // 1-based global index
			var lo = 0, hi = starts.length - 1;
			while (lo < hi) {
				var mid = (lo + hi) >> 1;
				if (starts[mid] < n) lo = mid + 1; else hi = mid;
			}
			var s = lo; // 1-based surah
			if (s < 1) s = 1;
			var base = starts[s - 1] || 0;
			var v = n - base;
			if (v < 1) v = 1;
			if (s !== exs || v !== exv) return [s, v];
		}
		// Fallback: step forward one verse if we somehow picked the same one.
		var fs = exs || 1, fv = (exv || 1) + 1;
		var fmax = (starts[fs] || 0) - (starts[fs - 1] || 0);
		if (fv > fmax) { fs = fs >= 114 ? 1 : fs + 1; fv = 1; }
		return [fs, fv];
	}

	function pickSurpriseVerse(exclude) {
		var starts = window.AAYATUN_SURAH_STARTS;
		var exKey = exclude && exclude[0] ? (exclude[0] + ':' + exclude[1]) : '';
		var seen = {};
		if (exKey) seen[exKey] = 1;
		for (var i = 0; i < shuffleHistory.length; i++) {
			var h = shuffleHistory[i];
			if (h && h[0]) seen[h[0] + ':' + h[1]] = 1;
		}
		try {
			if (window.AayatunRecent && window.AayatunRecent.map && Array.isArray(starts) && starts.length === 114) {
				var m = window.AayatunRecent.map();
				if (m && m.level && m.level.length >= 6236) {
					var unseen = [];
					for (var j = 0; j < 6236; j++) {
						if (!m.level[j]) {
							var sv = verseFromIndex(j);
							if (!seen[sv[0] + ':' + sv[1]]) unseen.push(j);
						}
					}
					if (unseen.length) return verseFromIndex(unseen[Math.floor(Math.random() * unseen.length)]);
				}
			}
		} catch (e) {}
		for (var tries = 0; tries < 30; tries++) {
			var pick = randomVerse(exclude);
			if (!seen[pick[0] + ':' + pick[1]]) return pick;
		}
		return randomVerse(exclude);
	}

	function seedShuffleHistory(data) {
		var d = data || state.data;
		if (!d) { shuffleHistory = []; shuffleCursor = -1; shuffleNext = null; return; }
		shuffleHistory = [[d.surah, d.verse]];
		shuffleCursor = 0;
		shuffleNext = null;
	}

	function syncShuffleHistory(data) {
		if (!shuffleOn) return;
		var d = data || state.data;
		if (!d) return;
		var k = key(d.surah, d.verse);
		if (shuffleCursor >= 0 && shuffleHistory[shuffleCursor] && key(shuffleHistory[shuffleCursor][0], shuffleHistory[shuffleCursor][1]) === k) return;
		if (shuffleCursor > 0 && shuffleHistory[shuffleCursor - 1] && key(shuffleHistory[shuffleCursor - 1][0], shuffleHistory[shuffleCursor - 1][1]) === k) {
			shuffleCursor--;
			return;
		}
		if (shuffleCursor >= 0 && shuffleCursor < shuffleHistory.length - 1 && shuffleHistory[shuffleCursor + 1] && key(shuffleHistory[shuffleCursor + 1][0], shuffleHistory[shuffleCursor + 1][1]) === k) {
			shuffleCursor++;
			return;
		}
		seedShuffleHistory(d);
	}

	function ensureShuffleNext() {
		if (!shuffleOn || !state.data) return null;
		if (shuffleCursor < shuffleHistory.length - 1) return shuffleHistory[shuffleCursor + 1];
		if (shuffleNext && shuffleNext[0]) return shuffleNext;
		shuffleNext = pickSurpriseVerse([state.data.surah, state.data.verse]);
		return shuffleNext;
	}

	function getNeighborTarget(dir) {
		if (shuffleOn) {
			if (dir === 'prev') return shuffleCursor > 0 ? shuffleHistory[shuffleCursor - 1] : null;
			return ensureShuffleNext();
		}
		return dir === 'next' ? (state.data && state.data.next) : (state.data && state.data.prev);
	}

	function key(s, v) { return s + ':' + v; }
	cache[key(initial.surah, initial.verse)] = initial;

	function fetchVerse(s, v) {
		var k = key(s, v);
		if (cache[k]) return Promise.resolve(cache[k]);
		if (inflight[k]) return inflight[k];
		inflight[k] = fetch(API + s + '/' + v, {
			headers: { 'X-Aayatun-Token': TOKEN },
			credentials: 'same-origin',
			cache: 'no-store'
		}).then(function (r) {
			if (!r.ok) throw new Error('http ' + r.status);
			return r.json();
		}).then(function (d) {
			delete inflight[k];
			cache[k] = d;
			updateNeighborPreviews();
			return d;
		}).catch(function (e) {
			delete inflight[k];
			throw e;
		});
		return inflight[k];
	}

	function prefetchNeighbors() {
		if (shuffleOn) {
			syncShuffleHistory();
			var p = getNeighborTarget('prev');
			var n = getNeighborTarget('next');
			if (p && p[0]) fetchVerse(p[0], p[1]).catch(function () {});
			if (n && n[0]) fetchVerse(n[0], n[1]).catch(function () {});
			updateNeighborPreviews();
			return;
		}
		var d = state.data;
		if (d.prev && d.prev[0]) fetchVerse(d.prev[0], d.prev[1]).catch(function () {});
		if (d.next && d.next[0]) fetchVerse(d.next[0], d.next[1]).catch(function () {});
		updateNeighborPreviews();
	}

	function isAtBeginning() {
		return state.phase === 'initial' || (state.phase === 'intro' && state.idx === 0);
	}

	function updatePartButtons() {
		if (prevPartBtn) prevPartBtn.disabled = isAtBeginning();
		if (nextPartBtn) nextPartBtn.disabled = state.phase === 'end-done';
	}

	function setPlaying(on) {
		state.playing = !!on;
		if (state.playing) requestWakeSafe();
		var replay = !state.playing && state.phase === 'end-done';
		if (playIcon) playIcon.className = 'icon ' + (state.playing ? 'pause' : (replay ? 'redo' : 'play'));
		if (playBtn) {
			var label = state.playing ? 'Pause' : (replay ? 'Replay' : 'Play');
			playBtn.setAttribute('aria-label', label);
			playBtn.setAttribute('title', label);
		}
		updatePartButtons();
	}

	function clearTimer() {
		if (state.timer) { clearTimeout(state.timer); state.timer = null; }
	}

	function ms(v) { return Math.round(v * SLOW); }

	function durationFor(count) {
		var per = 2600 - Math.min(count, 120) * 13;
		if (per < 1000) per = 1000;
		return per;
	}

	function phaseTimes() {
		var words = state.data.words || [];
		var w = words[state.idx] || { segments: [] };
		var segs = (w.segments || []).length;
		var total = durationFor(words.length || 1);
		var fly = reduced ? 0 : Math.max(260, Math.min(480, total * 0.18));
		var gap = Math.max(420, total * 0.22);
		return {
			word: ms(220),
			segStep: ms(220),
			segStart: ms(100),
			segEnd: ms(180),
			noBreak: ms(120),
			root: ms(260),
			meaning: ms(220),
			fly: ms(fly),
			gap: ms(gap),
			holdShort: ms(120)
		};
	}

	function baseTopFontSizes() {
		var n = (state.data.words || []).length;
		var v = 2.1;
		if (n > 30) v = 1.85;
		if (n > 50) v = 1.6;
		if (n > 80) v = 1.35;
		if (n > 120) v = 1.15;
		if (n > 180) v = 1.0;
		var m = 1.1;
		if (n > 30) m = 1.0;
		if (n > 50) m = 0.92;
		if (n > 80) m = 0.84;
		if (n > 120) m = 0.76;
		if (n > 180) m = 0.68;
		return { v: v, m: m };
	}

	function applyTopFontSizes(v, m) {
		var actualMode = stage && stage.classList.contains('show-actual-translation');
		if (actualMode) return;
		if (verseBox) verseBox.style.fontSize = v + 'rem';
		if (verseMeaning) verseMeaning.style.fontSize = m + 'rem';
		if (actualTranslationEl) actualTranslationEl.style.fontSize = '';
	}

	function fitVerseFont() {
		var b = baseTopFontSizes();
		applyTopFontSizes(b.v, b.m);
	}

	function topOverflows(top) {
		if (!top) return false;
		if (top.scrollHeight > top.clientHeight + 1) return true;
		if (verseBox && verseBox.scrollHeight > verseBox.clientHeight + 1) return true;
		if (verseMeaning && verseMeaning.scrollHeight > verseMeaning.clientHeight + 1) return true;
		if (actualTranslationEl && actualTranslationEl.scrollHeight > actualTranslationEl.clientHeight + 1) return true;
		return false;
	}

	function fitTopToContainer() {
		var top = verseBox ? verseBox.closest('.reel-top') : null;
		if (!top || !verseBox) return;
		if (stage && stage.classList.contains('show-actual-translation')) return;
		var b = baseTopFontSizes();
		var v = b.v, m = b.m;
		applyTopFontSizes(v, m);
		if (verseBox) verseBox.style.lineHeight = '';
		var guard = 140;
		while (guard-- > 0 && topOverflows(top)) {
			if (v <= 0.45 && m <= 0.4) break;
			v = Math.max(0.45, +(v - 0.04).toFixed(2));
			m = Math.max(0.4, +(m - 0.025).toFixed(2));
			applyTopFontSizes(v, m);
		}
		// tighten line-height / spacing if still overflowing
		if (topOverflows(top) && verseBox) {
			var lh = 1.9;
			var lguard = 30;
			while (lguard-- > 0 && topOverflows(top) && lh > 1.25) {
				lh = +(lh - 0.05).toFixed(2);
				verseBox.style.lineHeight = String(lh);
			}
		}
		var trEl = (stage && stage.classList.contains('show-actual-translation')) ? actualTranslationEl : verseMeaning;
		if (topOverflows(top) && trEl) {
			trEl.style.marginTop = '2px';
			trEl.style.lineHeight = '1.3';
		}
		if (verseMeaning) {
			if (trEl !== verseMeaning) { verseMeaning.style.marginTop = ''; verseMeaning.style.lineHeight = ''; }
			else if (!topOverflows(top)) { verseMeaning.style.marginTop = ''; verseMeaning.style.lineHeight = ''; }
		}
		if (actualTranslationEl) {
			if (trEl !== actualTranslationEl) { actualTranslationEl.style.marginTop = ''; actualTranslationEl.style.lineHeight = ''; }
			else if (!topOverflows(top)) { actualTranslationEl.style.marginTop = ''; actualTranslationEl.style.lineHeight = ''; }
		}
	}

	function scheduleTopFit() {
		fitTopToContainer();
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitTopToContainer);
	}

	// Shrink the morphology chips just enough to fit the middle row. The Arabic
	// word and its meaning keep their size: only --chip-scale changes.
	function fitMiddleChips() {
		if (!middleEl || !chipsEl) return;
		if (!chipsEl.querySelector('.reel-chip')) return;
		// Hidden during the opening scene / ended state: nothing to measure yet.
		if (!middleEl.clientHeight || !chipsEl.offsetParent) return;
		var midStyle = window.getComputedStyle(middleEl);
		var available = middleEl.clientHeight
			- (parseFloat(midStyle.paddingTop) || 0)
			- (parseFloat(midStyle.paddingBottom) || 0);
		if (wordAr) available -= wordAr.offsetHeight;
		if (wordMeaning) {
			available -= wordMeaning.offsetHeight + (parseFloat(window.getComputedStyle(wordMeaning).marginTop) || 0);
		}
		var scale = 1;
		chipsEl.style.setProperty('--chip-scale', '1');
		while (scale > 0.45) {
			var chipsStyle = window.getComputedStyle(chipsEl);
			var used = chipsEl.offsetHeight + (parseFloat(chipsStyle.marginTop) || 0);
			if (used <= available) break;
			scale = Math.max(0.45, +(scale - 0.05).toFixed(2));
			chipsEl.style.setProperty('--chip-scale', String(scale));
		}
	}

	function scheduleMiddleFit() {
		fitMiddleChips();
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitMiddleChips);
	}

	function resetVerseArea() {
		if (verseBox) verseBox.innerHTML = '';
		if (verseMeaning) verseMeaning.innerHTML = '';
		if (verseBox) verseBox.style.lineHeight = '';
		if (verseMeaning) { verseMeaning.style.marginTop = ''; verseMeaning.style.lineHeight = ''; }
		if (actualTranslationEl) { actualTranslationEl.style.marginTop = ''; actualTranslationEl.style.lineHeight = ''; }
		scheduleTopFit();
	}

	function getSpan(i) {
		return verseBox ? verseBox.querySelector('.rv-word[data-i="' + i + '"]') : null;
	}
	function getMeaningSpan(i) {
		return verseMeaning ? verseMeaning.querySelector('.rv-meaning[data-i="' + i + '"]') : null;
	}

	function ensureTopPlaceholder(i) {
		var sp = getSpan(i);
		if (sp) return sp;
		if (!verseBox) return null;
		var w = (state.data.words || [])[i];
		if (!w) return null;
		if (verseBox.childNodes.length) verseBox.appendChild(document.createTextNode(' '));
		sp = document.createElement('span');
		sp.className = 'rv-word is-hidden-target';
		sp.setAttribute('data-i', String(i));
		sp.textContent = w.ar;
		verseBox.appendChild(sp);
		scheduleTopFit();
		return sp;
	}

	function ensureMeaningPlaceholder(i) {
		var sp = getMeaningSpan(i);
		if (sp) return sp;
		if (!verseMeaning) return null;
		var w = (state.data.words || [])[i];
		if (!w) return null;
		if (verseMeaning.childNodes.length) verseMeaning.appendChild(document.createTextNode(' '));
		sp = document.createElement('span');
		sp.className = 'rv-meaning is-hidden-target';
		sp.setAttribute('data-i', String(i));
		sp.textContent = w.meaning || '';
		verseMeaning.appendChild(sp);
		scheduleTopFit();
		return sp;
	}

	function progressDots() {
		return progressEl ? progressEl.querySelectorAll('.reel-progress-dot') : [];
	}

	function wordCount() {
		return (state.data && state.data.words) ? state.data.words.length : 0;
	}
	function aiWordMeaningCount() {
		return (state.data && state.data.ai && state.data.ai.word_meanings) ? state.data.ai.word_meanings.length : 0;
	}
	function progressTotal() {
		// word-for-word count + AI context words count + 1 (AI context)
		return wordCount() + aiWordMeaningCount() + 1;
	}
	function aiWmPillIndex(i) {
		return wordCount() + i;
	}
	function aiContextPillIndex() {
		return wordCount() + aiWordMeaningCount();
	}

	function buildProgressPills() {
		if (!progressEl) return;
		progressEl.innerHTML = '';
		var count = progressTotal();
		for (var i = 0; i < count; i++) {
			var dot = document.createElement('span');
			dot.className = 'reel-progress-dot';
			dot.setAttribute('data-i', String(i));
			progressEl.appendChild(dot);
		}
	}

	function setProgressFilledUpTo(n) {
		var dots = progressDots();
		for (var i = 0; i < dots.length; i++) {
			if (i < n) dots[i].classList.add('is-done');
			else dots[i].classList.remove('is-done');
		}
	}

	function markProgressDone(i) {
		var dots = progressDots();
		if (i < 0) return;
		if (dots[i]) dots[i].classList.add('is-done');
	}

	function syncEndProgressPills() {
		var w = wordCount();
		var m = aiWordMeaningCount();
		var filled = w;
		var p = state.phase;
		if (p === 'end-done') {
			filled = progressTotal();
		} else if (p === 'end-context' || p === 'end-context-done-wait') {
			filled = w + m;
		} else if (p === 'end-wm-to-context-wait') {
			filled = w + m;
		} else if (p && p.indexOf('end-wm') === 0) {
			// state.endWmIdx is the current/next wm index depending on subphase.
			// Before/at start of an item: idx items done. After completing an item
			// (clearing), endWmIdx has advanced to idx+1 and that item is done.
			var doneWm = state.endWmIdx || 0;
			if (p === 'end-wm-start') doneWm = 0;
			if (p === 'end-wm-pretype' || p === 'end-wm-type' || p === 'end-wm-hold') {
				doneWm = state.endWmIdx || 0;
			}
			if (p === 'end-wm-clear' || p === 'end-wm-wait') {
				doneWm = state.endWmIdx || 0;
			}
			if (doneWm > m) doneWm = m;
			filled = w + doneWm;
		} else if (state.ended) {
			// fallback: keep words filled at least
			filled = w;
		}
		setProgressFilledUpTo(filled);
	}

	// Largest font size whose wrapped text still fits the given box.
	function fitTextToBox(el, boxW, boxH, minPx, maxPx, lineFn) {
		if (!el || !(el.textContent || '').trim()) return;
		if (!(boxW > 40) || !(boxH > 30)) return;

		el.style.whiteSpace = 'normal';
		el.style.overflow = 'hidden';
		el.style.display = 'block';

		function apply(px) {
			el.style.fontSize = px + 'px';
			el.style.lineHeight = lineFn(px);
		}
		function fits(px) {
			apply(px);
			// Height is the only limit: the text always wraps to the box width.
			return el.scrollHeight <= boxH + 1;
		}

		var lo = Math.max(8, minPx);
		var hi = Math.max(lo, maxPx);
		apply(lo);
		if (el.scrollHeight > boxH + 1) return; // even the minimum is too big
		apply(hi);
		if (el.scrollHeight <= boxH + 1) return; // the maximum already fits
		var best = lo;
		for (var i = 0; i < 18; i++) {
			var mid = (lo + hi) / 2;
			if (fits(mid)) { best = mid; lo = mid; }
			else { hi = mid; }
		}
		apply(Math.floor(best));
	}

	function fitOneOpeningStage(stg) {
		if (!stg || !stg.classList || !stg.classList.contains('is-initial-overview')) return;
		var top = stg.querySelector('.reel-top');
		var aEl = stg.querySelector('.reel-opening-verse');
		var tEl = stg.querySelector('.reel-opening-translation');
		if (!top || !aEl || !tEl) return;

		// Skip fitting if nothing to show (empty preview pane)
		if (!(aEl.textContent || '').trim() && !(tEl.textContent || '').trim()) return;

		var topW = top.clientWidth;
		var topH = top.clientHeight;
		// Layout not ready: leave the CSS fallback size in place and let the
		// retries / ResizeObserver call us again (never write a tiny size).
		if (!(topW > 160) || !(topH > 220)) return;

		var ref = top.querySelector('.reel-ref');
		var refH = 0;
		if (ref) {
			// Include the title's bottom margin: it belongs to the first row.
			var refCs = getComputedStyle(ref);
			refH = ref.getBoundingClientRect().height + (parseFloat(refCs.marginBottom) || 0);
		}
		var rowGap = 4; // .reel-stage.is-initial-overview .reel-top gap
		// A small safety buffer keeps the bottom text from kissing the stage edge.
		var remaining = Math.max(80, topH - refH - rowGap * 2 - 6);
		var topCs = getComputedStyle(top);
		var aCs = getComputedStyle(aEl);
		var boxW = Math.max(80,
			aEl.clientWidth - (parseFloat(aCs.paddingLeft) || 0) - (parseFloat(aCs.paddingRight) || 0) - 2);
		if (!(boxW > 40)) {
			boxW = Math.max(80, topW - (parseFloat(topCs.paddingLeft) || 0) - (parseFloat(topCs.paddingRight) || 0) - 8);
		}
		var arabicBoxH = Math.max(50, remaining * 0.75);
		var transBoxH = Math.max(30, remaining * 0.25);

		// A very long translation can need more than a quarter of the screen.
		// Give it the height it needs at the smallest readable size and take
		// that from the Arabic block, so nothing is ever clipped on the
		// opening scene. Short verses keep the exact 75 / 25 split.
		var tMin = Math.max(11, boxW * 0.02);
		var tLine = function (px) { return px < 14 ? '1.35' : (px < 22 ? '1.45' : '1.55'); };
		if ((tEl.textContent || '').trim()) {
			tEl.style.whiteSpace = 'normal';
			tEl.style.overflow = 'hidden';
			tEl.style.fontSize = tMin + 'px';
			tEl.style.lineHeight = tLine(tMin);
			var tNeeded = tEl.scrollHeight + 4;
			if (tNeeded > transBoxH) {
				transBoxH = Math.min(tNeeded, remaining * 0.55);
				arabicBoxH = Math.max(50, remaining - transBoxH);
			}
		}

		// The grid rows must match the measured split, otherwise a grown
		// translation would still be clipped by the CSS 3fr / 1fr rows.
		top.style.gridTemplateRows = refH + 'px ' + arabicBoxH + 'px ' + transBoxH + 'px';

		// Arabic fills the top block (bottom-aligned in its cell).
		fitTextToBox(aEl, boxW, arabicBoxH,
			Math.max(18, boxW * 0.045),
			Math.min(arabicBoxH * 0.62, boxW * 0.30, 220),
			function (px) { return px < 30 ? '1.5' : (px < 52 ? '1.65' : '1.8'); });

		// Translation fills the bottom block (top-aligned in its cell).
		fitTextToBox(tEl, boxW, transBoxH,
			tMin,
			Math.min(transBoxH * 0.55, boxW * 0.07, 64),
			tLine);
	}

	function fitOpeningScene() {
		var stages = track ? track.querySelectorAll('.reel-stage.is-initial-overview') : null;
		if (stages && stages.length) {
			for (var i = 0; i < stages.length; i++) fitOneOpeningStage(stages[i]);
		} else if (stage && stage.classList.contains('is-initial-overview')) {
			fitOneOpeningStage(stage);
		}
	}

	var openingFitPending = false;
	function scheduleOpeningFit() {
		if (openingFitPending) return;
		openingFitPending = true;
		var run = function () { openingFitPending = false; fitOpeningScene(); };
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
		else setTimeout(run, 16);
	}

	// Fonts and the viewport settle after first paint; refit a few times so the
	// opening scene always fills the screen instead of keeping an early size.
	var openingFitRetries = [];
	function fitOpeningSoon() {
		for (var i = 0; i < openingFitRetries.length; i++) clearTimeout(openingFitRetries[i]);
		openingFitRetries = [];
		scheduleOpeningFit();
		[60, 250, 700, 1400].forEach(function (delay) {
			openingFitRetries.push(setTimeout(scheduleOpeningFit, delay));
		});
	}

	function renderOpeningScene(data) {
		var d = data || state.data || {};
		if (openingVerseEl) openingVerseEl.textContent = d.ayah || '';
		if (openingTranslationEl) openingTranslationEl.textContent = d.translation || '';
		fitOpeningSoon();
	}

	function enterInitialOverview(startTimer) {
		clearTimer();
		stopTypewriter(false);
		cancelFlights();
		showEnd(false);
		if (stage) stage.classList.add('is-initial-overview');
		renderOpeningScene(state.data);
		clearMiddle({ immediate: true });
		clearBottom();
		state.idx = 0;
		state.ended = false;
		state.phase = 'initial';
		updatePartButtons();
		if (startTimer === false) {
			state.remaining = INITIAL_MS;
			setPlaying(false);
			return;
		}
		setPlaying(true);
		schedule(INITIAL_MS, function () { startRegularFlow(); });
	}

	function startRegularFlow() {
		if (stage) stage.classList.remove('is-initial-overview');
		if (openingVerseEl) openingVerseEl.textContent = '';
		if (openingTranslationEl) openingTranslationEl.textContent = '';
		resetVerseArea();
		clearMiddle({ immediate: true });
		clearBottom();
		state.idx = 0;
		setPlaying(true);
		startIntro();
	}

	function revealPlaced(i) {
		var sp = getSpan(i);
		var mp = getMeaningSpan(i);
		if (sp) { sp.classList.remove('is-hidden-target', 'is-active'); sp.classList.add('is-read', 'rv-landed'); }
		if (mp) { mp.classList.remove('is-hidden-target', 'is-active'); mp.classList.add('is-read', 'rv-landed'); }
		markProgressDone(i);
		// clear landed animation class later
		setTimeout(function () {
			if (sp) sp.classList.remove('rv-landed');
			if (mp) mp.classList.remove('rv-landed');
		}, ms(200));
	}

	function ensureVisible(i) {
		// No-op: top content is dynamically sized to fit (avoid scroll/shift).
	}

	function setProgress() {} // progress bar removed

	var midClearTimer = null;
	function clearMiddle(opts) {
		var immediate = opts && opts.immediate;
		if (midClearTimer) { clearTimeout(midClearTimer); midClearTimer = null; }
		if (immediate) {
			if (wordAr) { wordAr.classList.remove('is-fading', 'is-appearing'); wordAr.style.opacity = ''; wordAr.style.transform = ''; wordAr.textContent = ''; wordAr.style.display = ''; }
			if (wordMeaning) { wordMeaning.classList.remove('is-fading', 'is-appearing'); wordMeaning.style.opacity = ''; wordMeaning.style.transform = ''; wordMeaning.textContent = '\u00A0'; wordMeaning.style.visibility = 'hidden'; wordMeaning.style.display = ''; }
			if (chipsEl) { chipsEl.innerHTML = ''; chipsEl.style.display = ''; chipsEl.style.setProperty('--chip-scale', '1'); }
			return;
		}
		// fade out arabic word and blue translation (and clear chips)
		if (wordAr && wordAr.textContent) { wordAr.classList.remove('is-appearing'); wordAr.classList.add('is-fading'); }
		if (wordMeaning && wordMeaning.style.visibility !== 'hidden' && (wordMeaning.textContent || '').trim()) { wordMeaning.classList.remove('is-appearing'); wordMeaning.classList.add('is-fading'); }
		if (chipsEl) { chipsEl.innerHTML = ''; chipsEl.style.setProperty('--chip-scale', '1'); }
		midClearTimer = setTimeout(function () {
			midClearTimer = null;
			if (wordAr) { wordAr.classList.remove('is-fading', 'is-appearing'); wordAr.style.opacity = ''; wordAr.style.transform = ''; wordAr.textContent = ''; }
			if (wordMeaning) { wordMeaning.classList.remove('is-fading', 'is-appearing'); wordMeaning.style.opacity = ''; wordMeaning.style.transform = ''; wordMeaning.textContent = '\u00A0'; wordMeaning.style.visibility = 'hidden'; }
		}, 220);
	}

	function clearBottom() {
		if (defRoot) defRoot.textContent = '';
		if (defSep) defSep.textContent = '';
		if (defText) defText.textContent = '';
		if (morphCredit) morphCredit.hidden = true;
	}

	function setTopActualTranslation(on) {
		var turningOn = !!on && !(stage && stage.classList.contains('show-actual-translation'));
		if (turningOn) {
			// Keep AI-mode top sizes locked to the final word-by-word layout.
			if (actualTranslationEl && verseMeaning) {
				var fs = verseMeaning.style.fontSize;
				if (!fs) {
					try { fs = window.getComputedStyle(verseMeaning).fontSize; } catch (e) { fs = ''; }
				}
				if (fs) actualTranslationEl.style.fontSize = fs;
			}
			if (verseBox) {
				var vfs = verseBox.style.fontSize;
				if (!vfs) {
					try { vfs = window.getComputedStyle(verseBox).fontSize; } catch (e) { vfs = ''; }
				}
				if (vfs) verseBox.style.fontSize = vfs;
			}
		}
		if (!on) {
			if (actualTranslationEl) actualTranslationEl.style.fontSize = '';
			if (verseBox) verseBox.style.fontSize = '';
		}
		if (stage) stage.classList.toggle('show-actual-translation', !!on);
		if (actualTranslationEl && state.data) actualTranslationEl.textContent = state.data.translation || '';
		scheduleTopFit();
	}

	function resetEndPanel() {
		if (stage) stage.classList.remove('is-ended');
		setTopActualTranslation(false);
		if (endPanel) endPanel.hidden = true;
		if (endScroll) endScroll.scrollTop = 0;
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		if (endHint) { endHint.hidden = true; endHint.classList.remove('is-overlay'); }
		state.endWmIdx = 0;
		state.endWmTotal = 0;
	}

	function showEnd(on) {
		state.ended = !!on;
		if (!on) {
			resetEndPanel();
			return;
		}
		// ended layout: top 25% keeps built verse/actual translation, lower 75% shows end panel
		setTopActualTranslation(true);
		clearMiddle({ immediate: true });
		if (wordAr) wordAr.style.display = 'none';
		if (wordMeaning) wordMeaning.style.display = 'none';
		if (chipsEl) chipsEl.style.display = 'none';
		clearBottom();
		if (stage) stage.classList.add('is-ended');
		if (endPanel) endPanel.hidden = false;
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		if (endHint) endHint.hidden = true;
	}

	function startEndSequence() {
		showEnd(true);
		setPlaying(true);
		setProgressFilledUpTo(wordCount());
		var ai = state.data.ai || {};
		var ctx = ai.context || '';
		var wms = ai.word_meanings || [];
		state.endWmIdx = 0;
		state.endWmTotal = wms.length;
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		if (wms.length) {
			beginEndWordMeaningsSequence();
		} else if (ctx) {
			beginEndContextSequence();
		} else {
			if (endContext) endContext.textContent = 'Verse complete.';
			finishEndSequence();
		}
	}

	function beginEndWordMeaningsSequence() {
		// clear canvas before showing word meanings independently
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		if (endScroll) endScroll.scrollTop = 0;
		state.endWmIdx = 0;
		state.phase = 'end-wm-start';
		updatePartButtons();
		if (!state.playing) { state.remaining = ms(250); return; }
		schedule(ms(250), function () { showNextEndWordMeaning(); });
	}

	function beginEndContextAfterMeanings() {
		state.phase = 'end-wm-to-context-wait';
		updatePartButtons();
		if (!state.playing) { state.remaining = ms(700); return; }
		schedule(ms(700), function () { beginEndContextSequence(); });
	}

	function beginEndContextSequence() {
		// clear canvas, then typewrite verse context
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		if (endScroll) endScroll.scrollTop = 0;
		setProgressFilledUpTo(wordCount() + aiWordMeaningCount());
		var ctx = (state.data.ai && state.data.ai.context) || '';
		if (!ctx) { finishEndSequence(); return; }
		state.phase = 'end-context';
		updatePartButtons();
		startTypewriter(ctx, endContext);
	}

	function wmText(item) {
		if (!item) return '';
		var parts = [];
		var push = function (v) {
			v = (v || '').replace(/\s+/g, ' ').trim();
			if (v && parts.indexOf(v) === -1) parts.push(v);
		};
		push(item.meaning_here);
		push(item.classical_meaning);
		push(item.notable_usage);
		return parts.join('\n\n');
	}

	function appendWordWithBracketFont(el, text) {
		if (!el) return;
		el.textContent = '';
		var s = String(text || '');
		var re = /(\([^)]*\)|\[[^\]]*\])/g;
		var last = 0;
		var m;
		while ((m = re.exec(s)) !== null) {
			if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
			var span = document.createElement('span');
			span.className = 'reel-wm-word-latin';
			span.textContent = m[0];
			el.appendChild(span);
			last = re.lastIndex;
		}
		if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
		if (!el.childNodes.length) el.textContent = s;
	}

	function showNextEndWordMeaning() {
		var wms = (state.data.ai && state.data.ai.word_meanings) || [];
		state.endWmTotal = wms.length;
		if (state.endWmIdx >= wms.length) {
			setProgressFilledUpTo(wordCount() + aiWordMeaningCount());
			var ctx = (state.data.ai && state.data.ai.context) || '';
			if (ctx) beginEndContextAfterMeanings();
			else finishEndSequence();
			return;
		}
		var item = wms[state.endWmIdx] || {};
		if (endWm) {
			endWm.innerHTML = '';
			if (endScroll) endScroll.scrollTop = 0;
			var div = document.createElement('div');
			div.className = 'reel-wm-item';
			var word = document.createElement('div');
			word.className = 'reel-wm-word';
			appendWordWithBracketFont(word, item.word || '');
			var meaning = document.createElement('div');
			meaning.className = 'reel-wm-meaning';
			meaning.textContent = '';
			div.appendChild(word);
			div.appendChild(meaning);
			endWm.appendChild(div);
			requestAnimationFrame(function () { requestAnimationFrame(function () { div.classList.add('is-shown'); }); });
			state.phase = 'end-wm-pretype';
			state.twText = '';
			state.twPos = 0;
			state.twTarget = meaning;
			updatePartButtons();
			if (!state.playing) { state.remaining = ms(350); return; }
			schedule(ms(350), function () {
				state.phase = 'end-wm-type';
				startTypewriter(wmText(item), meaning);
			});
		} else {
			state.endWmIdx++;
			showNextEndWordMeaning();
		}
	}

	function clearCurrentEndWordMeaning() {
		var item = endWm ? endWm.querySelector('.reel-wm-item') : null;
		var completedIdx = state.endWmIdx;
		function next() {
			markProgressDone(aiWmPillIndex(completedIdx));
			if (endWm) endWm.innerHTML = '';
			state.endWmIdx++;
			state.phase = 'end-wm-clear';
			updatePartButtons();
			if (!state.playing) { state.remaining = ms(250); return; }
			schedule(ms(250), function () { showNextEndWordMeaning(); });
		}
		if (item) {
			item.classList.add('is-hiding');
			item.classList.remove('is-shown');
			setTimeout(next, 300);
		} else {
			next();
		}
	}

	function finishEndSequence() {
		state.phase = 'end-done';
		setProgressFilledUpTo(progressTotal());
		if (endHint) { endHint.hidden = false; endHint.classList.add('is-overlay'); }
		setPlaying(false);
		updatePartButtons();
	}

	function renderVerseInto(vBox, mBox, data) {
		if (!vBox) return;
		vBox.innerHTML = '';
		if (mBox) mBox.innerHTML = '';
		var words = (data && data.words) || [];
		for (var i = 0; i < words.length; i++) {
			var span = document.createElement('span');
			span.className = 'rv-word is-read';
			span.setAttribute('data-i', String(i));
			span.textContent = words[i].ar;
			vBox.appendChild(span);
			if (i < words.length - 1) vBox.appendChild(document.createTextNode(' '));
			if (mBox) {
				var m = document.createElement('span');
				m.className = 'rv-meaning is-read';
				m.setAttribute('data-i', String(i));
				m.textContent = words[i].meaning || '';
				mBox.appendChild(m);
				if (i < words.length - 1) mBox.appendChild(document.createTextNode(' '));
			}
		}
	}

	function renderFullVerse() {
		renderVerseInto(verseBox, verseMeaning, state.data);
		scheduleTopFit();
	}

	function paneHeight() {
		return viewport ? viewport.clientHeight : (stage ? stage.clientHeight : window.innerHeight);
	}

	function setTrackOffset(dy, animate) {
		if (!track) return;
		var h = paneHeight();
		if (animate) track.classList.add('is-sliding');
		else track.classList.remove('is-sliding');
		track.style.transform = 'translateY(' + (-h + dy) + 'px)';
	}

	function centerTrack(animate) {
		setTrackOffset(0, animate);
	}

	function clearPreviewPane(pane, dir) {
		if (!pane) return;
		var nameEl = pane.querySelector(dir === 'prev' ? '.reel-prev-name' : '.reel-next-name');
		var numEl = pane.querySelector(dir === 'prev' ? '.reel-prev-num' : '.reel-next-num');
		var vEl = pane.querySelector(dir === 'prev' ? '.reel-prev-verse' : '.reel-next-verse');
		var mEl = pane.querySelector(dir === 'prev' ? '.reel-prev-meaning' : '.reel-next-meaning');
		var ov = pane.querySelector(dir === 'prev' ? '.reel-prev-opening-verse' : '.reel-next-opening-verse');
		var ot = pane.querySelector(dir === 'prev' ? '.reel-prev-opening-translation' : '.reel-next-opening-translation');
		if (nameEl) nameEl.textContent = '';
		if (numEl) numEl.textContent = '';
		if (vEl) vEl.innerHTML = '';
		if (mEl) mEl.innerHTML = '';
		if (ov) ov.textContent = '';
		if (ot) ot.textContent = '';
	}

	function renderPreview(dir, data) {
		var pane = dir === 'prev' ? prevPane : nextPane;
		if (!pane) return;
		var target = getNeighborTarget(dir);
		var nameEl = pane.querySelector(dir === 'prev' ? '.reel-prev-name' : '.reel-next-name');
		var numEl = pane.querySelector(dir === 'prev' ? '.reel-prev-num' : '.reel-next-num');
		var vEl = pane.querySelector(dir === 'prev' ? '.reel-prev-verse' : '.reel-next-verse');
		var mEl = pane.querySelector(dir === 'prev' ? '.reel-prev-meaning' : '.reel-next-meaning');
		var ov = pane.querySelector(dir === 'prev' ? '.reel-prev-opening-verse' : '.reel-next-opening-verse');
		var ot = pane.querySelector(dir === 'prev' ? '.reel-prev-opening-translation' : '.reel-next-opening-translation');
		var stageEl = pane.querySelector('.reel-stage');

		// Render as opening scene (first reel screenplay frame) so swipe reveal/commit never shows empty.
		if (nameEl) nameEl.textContent = data ? (data.name || '') : ((target && target[0] && cache[key(target[0], target[1])]) ? cache[key(target[0], target[1])].name : '');
		if (numEl) numEl.textContent = data ? (data.surah + ':' + data.verse) : ((target && target[0]) ? (target[0] + ':' + target[1]) : '');
		if (vEl) vEl.innerHTML = '';
		if (mEl) mEl.innerHTML = '';
		if (ov) ov.textContent = data ? (data.ayah || '') : '';
		if (ot) ot.textContent = data ? (data.translation || '') : '';
		if (stageEl) stageEl.classList.add('is-initial-overview');
		fitOpeningSoon();
	}

	function updateNeighborPreviews() {
		var prevTarget = getNeighborTarget('prev');
		var nextTarget = getNeighborTarget('next');
		renderPreview('prev', (prevTarget && prevTarget[0]) ? (cache[key(prevTarget[0], prevTarget[1])] || null) : null);
		renderPreview('next', (nextTarget && nextTarget[0]) ? (cache[key(nextTarget[0], nextTarget[1])] || null) : null);
	}

	function escapeHtml(s) {
		return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function buildBreakdownChips(word) {
		if (!chipsEl) return 0;
		chipsEl.innerHTML = '';
		var segs = word.segments || [];
		for (var i = 0; i < segs.length; i++) {
			var chip = document.createElement('span');
			chip.className = 'reel-chip';
			chip.innerHTML = '<span class="seg">' + escapeHtml(segs[i][0] || '') + '</span>' +
				'<span class="role">→</span><span class="role">' + escapeHtml(segs[i][1] || '') + '</span>';
			chipsEl.appendChild(chip);
		}
		return segs.length;
	}

	function revealChip(i) {
		if (!chipsEl) return;
		var chips = chipsEl.querySelectorAll('.reel-chip');
		if (chips[i]) chips[i].classList.add('is-shown');
	}
	function revealAllChips() {
		if (!chipsEl) return;
		var chips = chipsEl.querySelectorAll('.reel-chip');
		for (var i = 0; i < chips.length; i++) chips[i].classList.add('is-shown');
	}

	function defForWord(word) {
		var key = word.defKey;
		var root = state.data.roots && key ? state.data.roots[key] : null;
		if (root) {
			var text = String(root.text || '').replace(/<br\s*\/?>/gi, '\n');
			if (root.meaning && !root.v2) text = String(root.meaning) + (text ? ' — ' + text : '');
			return {
				root: root.ar || word.root || word.lemma || '',
				text: text,
				v2: !!root.v2
			};
		}
		return {
			root: word.lemma || word.root || word.ar || '',
			text: word.meaning || '',
			v2: false
		};
	}

	// Typewriter (generalized)
	function stopTypewriter(finish) {
		if (state.twTimer) { clearTimeout(state.twTimer); state.twTimer = null; }
		var target = state.twTarget || defText;
		if (finish && target && state.twPos < state.twText.length) {
			target.textContent = state.twText;
			state.twPos = state.twText.length;
		}
	}
	function typeStep() {
		state.twTimer = null;
		if (!state.playing) return;
		if (state.ended && state.phase !== 'end-context' && state.phase !== 'end-wm-type') return;
		if (state.twPos >= state.twText.length) return;
		var chunk = reduced ? state.twText.length : 2;
		var next = Math.min(state.twText.length, state.twPos + chunk);
		state.twPos = next;
		var target = state.twTarget || defText;
		if (target) target.textContent = state.twText.slice(0, next);
		// Keep typing position in view.
		if (target === defText && defLine) defLine.scrollTop = defLine.scrollHeight;
		if (state.phase === 'end-wm-type' && endScroll) endScroll.scrollTop = endScroll.scrollHeight;
		if (state.phase === 'end-context' && endScroll) endScroll.scrollTop = endScroll.scrollHeight;
		if (state.twPos < state.twText.length) {
			state.twTimer = setTimeout(typeStep, ms(21));
		} else {
			onTypewriterDone();
		}
	}
	function startTypewriter(text, target) {
		stopTypewriter(false);
		state.twText = text || '';
		state.twPos = 0;
		state.twTarget = target || defText;
		if (state.twTarget) state.twTarget.textContent = '';
		if (!state.twText) { onTypewriterDone(); return; }
		if (reduced) {
			if (state.twTarget) state.twTarget.textContent = state.twText;
			state.twPos = state.twText.length;
			onTypewriterDone();
			return;
		}
		state.twTimer = setTimeout(typeStep, ms(21));
	}
	function pauseTypewriter() {
		if (state.twTimer) { clearTimeout(state.twTimer); state.twTimer = null; }
	}
	function resumeTypewriter() {
		if (reduced) return;
		if (state.twPos < state.twText.length && !state.twTimer && state.playing) {
			state.twTimer = setTimeout(typeStep, ms(18));
		}
	}
	function onTypewriterDone() {
		if (state.phase === 'end-context') {
			state.phase = 'end-context-done-wait';
			if (state.playing) schedule(ms(500), function () { finishEndSequence(); });
			else state.remaining = ms(500);
			return;
		}
		if (state.phase === 'rootmeaning') {
			state.phase = 'rootmeaning-done';
			if (state.playing) schedule(ROOT_HOLD_MS, function () { startPhase('fly'); });
			else state.remaining = ROOT_HOLD_MS;
			return;
		}
		if (state.phase === 'end-wm-type') {
			state.phase = 'end-wm-hold';
			if (state.playing) schedule(ms(900), function () { clearCurrentEndWordMeaning(); });
			else state.remaining = ms(900);
			return;
		}
	}

	function animateMidIn(el) {
		if (!el) return;
		if (midClearTimer) { clearTimeout(midClearTimer); midClearTimer = null; }
		el.classList.remove('is-fading');
		el.classList.add('is-appearing');
		// Force reflow so the "appearing" state is committed before the transition starts.
		void el.offsetWidth;
		requestAnimationFrame(function () {
			el.classList.remove('is-appearing');
		});
	}

	function showWord(i) {
		var words = state.data.words || [];
		if (i < 0 || i >= words.length) return;
		state.idx = i;
		state.phase = 'word';
		showEnd(false);
		var w = words[i];
		if (midClearTimer) { clearTimeout(midClearTimer); midClearTimer = null; }

		// 1) Arabic word appears in middle with fade-in (like breakdown); meaning placeholder keeps layout stable
		if (wordAr) {
			wordAr.style.opacity = '';
			wordAr.style.transform = '';
			wordAr.textContent = w.ar;
			wordAr.style.display = '';
			animateMidIn(wordAr);
		}
		if (wordMeaning) {
			wordMeaning.classList.remove('is-fading', 'is-appearing');
			wordMeaning.style.opacity = '';
			wordMeaning.style.transform = '';
			wordMeaning.textContent = '\u00A0';
			wordMeaning.style.visibility = 'hidden';
			wordMeaning.style.display = '';
		}
		if (chipsEl) { chipsEl.classList.remove('is-fading'); chipsEl.style.display = ''; }
		state.breakdownTotal = buildBreakdownChips(w);
		state.breakdownIdx = 0;
		scheduleMiddleFit();
		clearBottom();

		setProgress();
	}

	function cancelFlights() {
		if (!state.flights) return;
		for (var i = 0; i < state.flights.length; i++) {
			try { state.flights[i].cancel(); } catch (e) {}
		}
		state.flights = null;
	}

	function stopAllWordAnimations(finishTypewriter) {
		clearTimer();
		stopTypewriter(!!finishTypewriter);
		cancelFlights();
	}

	function completeCurrentWordPlacement() {
		var words = state.data.words || [];
		if (state.idx < 0 || state.idx >= words.length) return;
		ensureTopPlaceholder(state.idx);
		ensureMeaningPlaceholder(state.idx);
		revealPlaced(state.idx);
		clearMiddle({ immediate: true });
		clearBottom();
		setProgress();
	}

	function rebuildTopUpTo(k) {
		resetVerseArea();
		var words = state.data.words || [];
		for (var i = 0; i < k && i < words.length; i++) {
			if (verseBox.childNodes.length) verseBox.appendChild(document.createTextNode(' '));
			var sp = document.createElement('span');
			sp.className = 'rv-word is-read';
			sp.setAttribute('data-i', String(i));
			sp.textContent = words[i].ar;
			verseBox.appendChild(sp);
			if (verseMeaning) {
				if (verseMeaning.childNodes.length) verseMeaning.appendChild(document.createTextNode(' '));
				var mp = document.createElement('span');
				mp.className = 'rv-meaning is-read';
				mp.setAttribute('data-i', String(i));
				mp.textContent = words[i].meaning || '';
				verseMeaning.appendChild(mp);
			}
		}
		fitTopToContainer();
		setProgressFilledUpTo(k);
	}

	function advanceToWordOrEnd(nextIdx) {
		var words = state.data.words || [];
		if (nextIdx >= words.length) {
			startEndSequence();
		} else {
			state.idx = nextIdx;
			state.phase = 'idle';
			clearMiddle({ immediate: true });
			clearBottom();
			setPlaying(true);
			startPhase('word', nextIdx);
		}
	}

	function skipNextPart() {
		if (state.ended) { skipNextEndPart(); return; }
		if (state.phase === 'initial') {
			stopAllWordAnimations(false);
			startRegularFlow();
			return;
		}
		stopAllWordAnimations(true);
		var words = state.data.words || [];
		if (state.phase === 'intro') {
			state.idx = 0;
			completeCurrentWordPlacement();
			advanceToWordOrEnd(1);
			return;
		}
		if (state.phase === 'gap') {
			advanceToWordOrEnd(state.idx + 1);
			return;
		}
		if (state.phase === 'end-wait') {
			startEndSequence();
			return;
		}
		completeCurrentWordPlacement();
		advanceToWordOrEnd(state.idx + 1);
	}

	function skipPrevPart() {
		if (state.ended) { skipPrevEndPart(); return; }
		if (state.phase === 'initial') return;
		stopAllWordAnimations(false);
		var words = state.data.words || [];
		var target;
		if (state.phase === 'intro') {
			target = 0;
		} else if (state.phase === 'gap') {
			target = state.idx;
		} else if (state.phase === 'end-wait') {
			target = Math.max(0, words.length - 1);
		} else {
			target = state.idx - 1;
		}
		if (target < 0) target = 0;
		if (words.length && target >= words.length) target = words.length - 1;
		if (stage) stage.classList.remove('is-initial-overview');
		showEnd(false);
		rebuildTopUpTo(target);
		clearMiddle({ immediate: true });
		clearBottom();
		state.idx = target;
		state.ended = false;
		state.phase = 'idle';
		setPlaying(true);
		startPhase('word', target);
	}

	function leaveEndDone() {
		state.ended = true;
		setTopActualTranslation(true);
		if (endHint) { endHint.hidden = true; endHint.classList.remove('is-overlay'); }
		if (stage) stage.classList.add('is-ended');
		if (endPanel) endPanel.hidden = false;
		updatePartButtons();
	}

	function showEndWordMeaningAt(idx) {
		stopTypewriter(false);
		clearTimer();
		leaveEndDone();
		if (endContext) endContext.textContent = '';
		if (endWm) endWm.innerHTML = '';
		state.endWmIdx = idx;
		setProgressFilledUpTo(wordCount() + Math.max(0, idx));
		setPlaying(true);
		showNextEndWordMeaning();
	}

	function skipNextEndPart() {
		var wms = (state.data.ai && state.data.ai.word_meanings) || [];
		var ctx = (state.data.ai && state.data.ai.context) || '';
		var p = state.phase;
		stopAllWordAnimations(true);
		if (p === 'end-done') return;
		if (p === 'end-context' || p === 'end-context-done-wait') {
			stopTypewriter(true);
			if (endContext && ctx) endContext.textContent = ctx;
			finishEndSequence();
			return;
		}
		if (p === 'end-wm-to-context-wait') {
			if (ctx) beginEndContextSequence();
			else finishEndSequence();
			return;
		}
		if (p && p.indexOf('end-wm') === 0) {
			if (p === 'end-wm-type' || p === 'end-wm-hold' || p === 'end-wm-pretype') {
				// Current word-meaning item is completed/skipped.
				markProgressDone(aiWmPillIndex(state.endWmIdx));
				if (endWm) endWm.innerHTML = '';
				state.endWmIdx++;
			} else if (p === 'end-wm-clear' || p === 'end-wm-wait') {
				// idx positioned for next/first; item already accounted for in clear flow
			} else if (p === 'end-wm-start') {
				// starting from first item
			}
			if (endContext) endContext.textContent = '';
			leaveEndDone();
			setProgressFilledUpTo(wordCount() + Math.min(state.endWmIdx, aiWordMeaningCount()));
			setPlaying(true);
			showNextEndWordMeaning();
			return;
		}
		finishEndSequence();
	}

	function enterWordMeaningSegment(wordIdx) {
		var words = state.data.words || [];
		if (!words.length) { showEnd(false); startIntro(); return; }
		if (wordIdx < 0) wordIdx = 0;
		if (wordIdx >= words.length) wordIdx = words.length - 1;
		stopAllWordAnimations(false);
		showEnd(false);
		rebuildTopUpTo(wordIdx);
		clearBottom();
		state.ended = false;
		state.idx = wordIdx;
		state.phase = 'wordmeaning';
		state.wordmeaningStep = 1;
		setPlaying(true);
		// Set up Arabic word in middle, then reveal its blue meaning (word-for-word meaning segment).
		showWord(wordIdx);
		var w = words[wordIdx] || {};
		if (wordMeaning) {
			wordMeaning.style.opacity = '';
			wordMeaning.style.transform = '';
			wordMeaning.textContent = w.meaning || '\u00A0';
			wordMeaning.style.visibility = 'visible';
			wordMeaning.style.display = '';
			animateMidIn(wordMeaning);
		}
		scheduleMiddleFit();
		updatePartButtons();
		if (!state.playing) { state.remaining = phaseTimes().meaning; return; }
		schedule(phaseTimes().meaning, function () { startBreakdown(); });
	}

	function skipPrevEndPart() {
		var wms = (state.data.ai && state.data.ai.word_meanings) || [];
		var ctx = (state.data.ai && state.data.ai.context) || '';
		var p = state.phase;
		stopAllWordAnimations(false);
		if (p === 'end-done') {
			if (ctx) { leaveEndDone(); setPlaying(true); setProgressFilledUpTo(wordCount() + aiWordMeaningCount()); beginEndContextSequence(); }
			else if (wms.length) { showEndWordMeaningAt(wms.length - 1); }
			else {
				var last = (state.data.words || []).length - 1;
				if (last >= 0) enterWordMeaningSegment(last);
			}
			return;
		}
		if (p === 'end-context' || p === 'end-context-done-wait') {
			if (wms.length) { showEndWordMeaningAt(wms.length - 1); }
			else {
				var last2 = (state.data.words || []).length - 1;
				if (last2 >= 0) enterWordMeaningSegment(last2);
				else { leaveEndDone(); setPlaying(true); setProgressFilledUpTo(wordCount() + aiWordMeaningCount()); beginEndContextSequence(); }
			}
			return;
		}
		if (p === 'end-wm-to-context-wait') {
			if (wms.length) { showEndWordMeaningAt(wms.length - 1); }
			else {
				var last3 = (state.data.words || []).length - 1;
				if (last3 >= 0) enterWordMeaningSegment(last3);
				else { leaveEndDone(); setPlaying(true); setProgressFilledUpTo(wordCount() + aiWordMeaningCount()); beginEndContextSequence(); }
			}
			return;
		}
		if (p && p.indexOf('end-wm') === 0) {
			var targetIdx = state.endWmIdx - 1;
			if (targetIdx < 0) {
				var lastWord = (state.data.words || []).length - 1;
				if (lastWord >= 0) enterWordMeaningSegment(lastWord);
				return;
			}
			showEndWordMeaningAt(targetIdx);
			return;
		}
	}

	function flyWord(onDone) {
		if (reduced) { onDone(); return; }
		var srcWord = wordAr;
		var srcMean = wordMeaning;
		var dstWord = ensureTopPlaceholder(state.idx);
		var dstMean = ensureMeaningPlaceholder(state.idx);
		ensureVisible(state.idx);
		var anims = [];
		var pending = 0;
		var finished = false;

		function makeFlight(src, dst, isMeaning) {
			if (!src || !dst) return null;
			var sr = src.getBoundingClientRect();
			var dr = dst.getBoundingClientRect();
			if (!sr.width || !dr.width) return null;
			var clone = document.createElement('div');
			clone.className = 'reel-fly-clone';
			clone.textContent = src.textContent;
			clone.style.left = sr.left + 'px';
			clone.style.top = sr.top + 'px';
			clone.style.width = sr.width + 'px';
			var cs = window.getComputedStyle(src);
			clone.style.fontSize = cs.fontSize;
			clone.style.lineHeight = cs.lineHeight;
			clone.style.fontFamily = cs.fontFamily;
			clone.style.fontWeight = cs.fontWeight;
			clone.style.textAlign = 'center';
			if (isMeaning) {
				clone.style.color = 'var(--reel-accent)';
				clone.style.direction = 'ltr';
			}
			document.body.appendChild(clone);
			var dx = (dr.left + dr.width / 2) - (sr.left + sr.width / 2);
			var dy = (dr.top + dr.height / 2) - (sr.top + sr.height / 2);
			var sx = dr.width / Math.max(sr.width, 1);
			var sy = dr.height / Math.max(sr.height, 1);
			var scale = Math.min(sx, sy);
			if (isMeaning) scale = Math.min(scale, 1.15);
			var anim = clone.animate([
				{ transform: 'translate(0px,0px) scale(1)', opacity: 1 },
				{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')', opacity: 0.95 }
			], { duration: phaseTimes().fly, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
			var done = function () {
				if (clone.parentNode) clone.parentNode.removeChild(clone);
				pending--;
				if (pending <= 0 && !finished) { finished = true; state.flights = null; onDone(); }
			};
			anim.onfinish = done;
			anim.oncancel = function () { if (clone.parentNode) clone.parentNode.removeChild(clone); };
			pending++;
			return anim;
		}

		var a1 = makeFlight(srcWord, dstWord, false);
		var a2 = makeFlight(srcMean, dstMean, true);
		if (a1) anims.push(a1);
		if (a2) anims.push(a2);
		if (!anims.length) { onDone(); return; }
		state.flights = anims;
	}

	function finishWord() {
		stopTypewriter(true);
		cancelFlights();
		revealPlaced(state.idx);
		clearMiddle({ immediate: true });
		setProgress();
		var words = state.data.words || [];
		var next = state.idx + 1;
		if (next >= words.length) {
			state.phase = 'end-wait';
			if (!state.playing) { state.remaining = ms(500); return; }
			schedule(ms(500), function () { startEndSequence(); });
			return;
		}
		startPhase('gap');
	}

	function schedule(msVal, fn) {
		clearTimer();
		state.remaining = msVal;
		state.phaseStarted = Date.now();
		state.timer = setTimeout(function () {
			state.timer = null;
			if (state.playing) fn();
		}, msVal);
	}

	function startBreakdown() {
		var t = phaseTimes();
		state.phase = 'breakdown';
		state.breakdownIdx = 0;
		if (!state.playing) return;
		if (state.breakdownTotal === 0) {
			schedule(t.noBreak, function () { startPhase('rootmeaning'); });
			return;
		}
		function step() {
			if (!state.playing) return;
			if (state.breakdownIdx < state.breakdownTotal) {
				revealChip(state.breakdownIdx);
				state.breakdownIdx++;
				if (state.breakdownIdx < state.breakdownTotal) {
					schedule(t.segStep, step);
				} else {
					schedule(t.segEnd, function () { startPhase('rootmeaning'); });
				}
			} else {
				schedule(t.holdShort, function () { startPhase('rootmeaning'); });
			}
		}
		if (reduced) {
			revealAllChips();
			schedule(t.holdShort, function () { startPhase('rootmeaning'); });
		} else {
			schedule(t.segStart, step);
		}
	}

	var INTRO_MS = ms(800);
	// Let the finished root definition sit for a beat before the word flies up.
	var ROOT_HOLD_MS = ms(400);

	function startIntro() {
		state.phase = 'intro';
		updatePartButtons();
		if (!state.playing) { state.remaining = INTRO_MS; return; }
		schedule(INTRO_MS, function () { startPhase('word', 0); });
	}

	function startPhase(phase, idx) {
		if (typeof idx === 'number') showWord(idx);
		var t = phaseTimes();
		var w = (state.data.words || [])[state.idx] || {};
		state.phase = phase;
		updatePartButtons();
		if (!state.playing) return;

		if (phase === 'word') {
			schedule(t.word, function () { startPhase('wordmeaning'); });
		} else if (phase === 'wordmeaning') {
			state.wordmeaningStep = 0;
			schedule(ms(300), function () {
				if (wordMeaning) {
					wordMeaning.style.opacity = '';
					wordMeaning.style.transform = '';
					wordMeaning.textContent = w.meaning || '\u00A0';
					wordMeaning.style.visibility = 'visible';
					wordMeaning.style.display = '';
					animateMidIn(wordMeaning);
				}
				scheduleMiddleFit();
				state.wordmeaningStep = 1;
				schedule(t.meaning, function () { startBreakdown(); });
			});
		} else if (phase === 'rootmeaning') {
			var def = defForWord(w);
			if (defRoot) defRoot.textContent = def.root || '';
			if (defSep) defSep.textContent = def.root ? ': ' : '';
			if (bottom) bottom.scrollTop = 0;
			if (morphCredit) morphCredit.hidden = !def.v2;
			scheduleMiddleFit();
			startTypewriter(def.text, defText);
			// advance on typewriter completion (onTypewriterDone)
		} else if (phase === 'fly') {
			if (reduced) { finishWord(); return; }
			// ensure placeholders exist for measurement
			ensureTopPlaceholder(state.idx);
			ensureMeaningPlaceholder(state.idx);
			ensureVisible(state.idx);
			state.remaining = t.fly;
			state.phaseStarted = Date.now();
			flyWord(function () { finishWord(); });
		} else if (phase === 'gap') {
			schedule(t.gap, function () {
				var next = state.idx + 1;
				var words = state.data.words || [];
				if (next >= words.length) {
					startEndSequence();
				} else {
					startPhase('word', next);
				}
			});
		}
	}

	function pause() {
		if (!state.playing) return;
		setPlaying(false);
		pauseTypewriter();
		if (state.flights) {
			for (var i = 0; i < state.flights.length; i++) {
				try { state.flights[i].pause(); } catch (e) {}
			}
		} else if (state.timer) {
			var elapsed = Date.now() - state.phaseStarted;
			state.remaining = Math.max(0, state.remaining - elapsed);
			clearTimer();
		}
	}

	function resume() {
		if (state.playing) return;
		setPlaying(true);
		if (state.phase === 'end-done' || (state.ended && state.phase === 'idle')) { replay(); return; }
		if (state.phase === 'initial') {
			schedule(Math.max(30, state.remaining || INITIAL_MS), function () { startRegularFlow(); });
			return;
		}
		if (state.phase === 'intro') {
			schedule(Math.max(30, state.remaining || INTRO_MS), function () { startPhase('word', 0); });
			return;
		}
		if (state.flights) {
			for (var i = 0; i < state.flights.length; i++) {
				try { state.flights[i].play(); } catch (e) {}
			}
			return;
		}
		if (state.phase === 'idle') { startPhase('word', state.idx); return; }

		var t = phaseTimes();

		// typewriter-driven phases
		if (state.phase === 'rootmeaning') {
			if (state.twPos >= state.twText.length && state.twText.length > 0) {
				state.phase = 'rootmeaning-done';
				schedule(ROOT_HOLD_MS, function () { startPhase('fly'); });
			} else if (state.twText) {
				resumeTypewriter();
			} else {
				// typewriter not started yet (e.g. paused immediately)
				var w = (state.data.words || [])[state.idx] || {};
				var def = defForWord(w);
				if (defRoot) defRoot.textContent = def.root || '';
				if (defSep) defSep.textContent = def.root ? ': ' : '';
				if (bottom) bottom.scrollTop = 0;
				if (morphCredit) morphCredit.hidden = !def.v2;
				scheduleMiddleFit();
				startTypewriter(def.text, defText);
			}
			return;
		}
		if (state.phase === 'rootmeaning-done') {
			schedule(Math.max(30, state.remaining || ROOT_HOLD_MS), function () { startPhase('fly'); });
			return;
		}
		if (state.phase === 'end-context') {
			if (state.twPos >= state.twText.length && state.twText.length > 0) {
				state.phase = 'end-context-done-wait';
				schedule(Math.max(30, state.remaining || ms(500)), function () { finishEndSequence(); });
			} else if (state.twText) {
				resumeTypewriter();
			} else {
				var ai = state.data.ai || {};
				startTypewriter(ai.context || '', endContext);
			}
			return;
		}
		if (state.phase === 'end-context-done-wait') {
			schedule(Math.max(30, state.remaining || ms(500)), function () { finishEndSequence(); });
			return;
		}
		if (state.phase === 'end-wm-start') {
			schedule(Math.max(30, state.remaining || ms(250)), function () { showNextEndWordMeaning(); });
			return;
		}
		if (state.phase === 'end-wm-pretype') {
			var wms = (state.data.ai && state.data.ai.word_meanings) || [];
			var item = wms[state.endWmIdx] || {};
			schedule(Math.max(30, state.remaining || ms(350)), function () {
				state.phase = 'end-wm-type';
				updatePartButtons();
				startTypewriter(wmText(item), state.twTarget);
			});
			return;
		}
		if (state.phase === 'end-wm-to-context-wait') {
			schedule(Math.max(30, state.remaining || ms(700)), function () { beginEndContextSequence(); });
			return;
		}
		if (state.phase === 'end-wait') {
			schedule(Math.max(30, state.remaining || ms(500)), function () { startEndSequence(); });
			return;
		}
		if (state.phase === 'end-wm-type') {
			if (state.twPos >= state.twText.length) {
				state.phase = 'end-wm-hold';
				schedule(Math.max(30, state.remaining || ms(900)), function () { clearCurrentEndWordMeaning(); });
			} else {
				resumeTypewriter();
			}
			return;
		}
		if (state.phase === 'end-wm-hold') {
			schedule(Math.max(30, state.remaining || ms(900)), function () { clearCurrentEndWordMeaning(); });
			return;
		}
		if (state.phase === 'end-wm-clear' || state.phase === 'end-wm-wait') {
			schedule(Math.max(30, state.remaining || ms(250)), function () { showNextEndWordMeaning(); });
			return;
		}

		if (state.phase === 'breakdown') {
			if (reduced) { revealAllChips(); schedule(t.holdShort, function () { startPhase('rootmeaning'); }); return; }
			function step() {
				if (!state.playing) return;
				if (state.breakdownIdx < state.breakdownTotal) {
					revealChip(state.breakdownIdx);
					state.breakdownIdx++;
					if (state.breakdownIdx < state.breakdownTotal) schedule(t.segStep, step);
					else schedule(t.segEnd, function () { startPhase('rootmeaning'); });
				} else {
					schedule(t.holdShort, function () { startPhase('rootmeaning'); });
				}
			}
			schedule(Math.max(30, state.remaining || t.segStep), step);
			return;
		}

		var fn;
		if (state.phase === 'word') fn = function () { startPhase('wordmeaning'); };
		else if (state.phase === 'wordmeaning') {
			if (state.wordmeaningStep === 0) {
				fn = function () {
					var w = (state.data.words || [])[state.idx] || {};
					if (wordMeaning) {
						wordMeaning.style.opacity = '';
						wordMeaning.style.transform = '';
						wordMeaning.textContent = w.meaning || '\u00A0';
						wordMeaning.style.visibility = 'visible';
						wordMeaning.style.display = '';
						animateMidIn(wordMeaning);
					}
					scheduleMiddleFit();
					state.wordmeaningStep = 1;
					schedule(phaseTimes().meaning, function () { startBreakdown(); });
				};
			} else {
				fn = function () { startBreakdown(); };
			}
		}
		else if (state.phase === 'fly') fn = function () { startPhase('fly'); };
		else if (state.phase === 'gap') fn = function () {
			var next = state.idx + 1;
			var words = state.data.words || [];
			if (next >= words.length) startEndSequence();
			else startPhase('word', next);
		};
		else fn = function () { startPhase('word', state.idx); };

		schedule(Math.max(30, state.remaining || 0), fn);
	}

	function replay() {
		clearTimer();
		stopTypewriter(false);
		cancelFlights();
		showEnd(false);
		resetVerseArea();
		clearMiddle({ immediate: true });
		clearBottom();
		buildProgressPills();
		enterInitialOverview(true);
	}

	function updateMeta(data) {
		document.title = data.name + ' ' + data.surah + ':' + data.verse + ' — Reel : Aayatun';
		if (refNum) refNum.textContent = data.surah + ':' + data.verse;
		var ref = document.getElementById('reel-ref');
		if (ref && ref.firstChild) ref.firstChild.textContent = 'Aayatun · ' + data.name + ' ';
		var metaRead = document.querySelector('meta[name="aayatun-read"]');
		if (metaRead) metaRead.setAttribute('content', 'verse|' + data.surah + ':' + data.verse + '|' + data.surah + ':' + data.verse + ' · ' + data.name);
	}

	function emitVerse(data) {
		try {
			document.dispatchEvent(new CustomEvent('aayatun:verse', {
				detail: { surah: data.surah, verse: data.verse, name: data.name }
			}));
		} catch (e) {}
	}

	function applyData(data, push) {
		clearTimer();
		stopTypewriter(false);
		cancelFlights();
		state.data = data;
		state.idx = 0;
		state.ended = false;
		state.phase = 'idle';
		if (actualTranslationEl) actualTranslationEl.textContent = data.translation || '';
		cache[key(data.surah, data.verse)] = data;
		updateMeta(data);
		buildProgressPills();
		setProgressFilledUpTo(0);
		resetVerseArea();
		clearMiddle({ immediate: true });
		clearBottom();
		showEnd(false);
		enterInitialOverview(true);
		// Keep a single reel history entry to avoid stacking; URL follows current verse.
		try { history.replaceState({ surah: data.surah, verse: data.verse }, '', '/reel/' + data.surah + '/' + data.verse); } catch (e) {}
		emitVerse(data);
		syncShuffleHistory(data);
		prefetchNeighbors();
	}

	function goTo(s, v, push) {
		var k = key(s, v);
		if (cache[k]) { applyData(cache[k], push !== false); return; }
		fetchVerse(s, v).then(function (d) { applyData(d, push !== false); }).catch(function () {
			window.location.href = '/reel/' + s + '/' + v;
		});
	}

	function navigate(dir) {
		if (shuffleOn) {
			syncShuffleHistory();
			var target = null;
			if (dir === 'prev') {
				if (shuffleCursor > 0) {
					shuffleCursor--;
					target = shuffleHistory[shuffleCursor];
				}
			} else {
				if (shuffleCursor < shuffleHistory.length - 1) {
					shuffleCursor++;
					target = shuffleHistory[shuffleCursor];
				} else {
					target = ensureShuffleNext();
					if (target && target[0]) {
						shuffleHistory.push([target[0], target[1]]);
						shuffleCursor = shuffleHistory.length - 1;
						shuffleNext = null;
					}
				}
			}
			if (target && target[0]) goTo(target[0], target[1], true);
			return;
		}
		var target = dir === 'next' ? state.data.next : state.data.prev;
		if (target && target[0]) goTo(target[0], target[1], true);
	}

	// Controls
	if (playBtn) playBtn.addEventListener('click', function () {
		if (state.playing) pause(); else resume();
	});
	if (prevPartBtn) prevPartBtn.addEventListener('click', function () { skipPrevPart(); });
	if (nextPartBtn) nextPartBtn.addEventListener('click', function () { skipNextPart(); });
	if (closeBtn) closeBtn.addEventListener('click', function () {
		var url = '/' + state.data.surah + '/' + state.data.verse;
		if (window.AayatunNav) window.AayatunNav.go(url);
		else window.location.href = url;
	});
	if (shareBtn) shareBtn.addEventListener('click', function () {
		if (window.AayatunShare && window.AayatunShare.shareReel) {
			window.AayatunShare.shareReel({
				surah: state.data.surah,
				verse: state.data.verse,
				name: state.data.name,
				ayah: state.data.ayah,
				translation: state.data.translation,
				words: state.data.words
			}, shareBtn);
		}
	});
	if (shuffleBtn) shuffleBtn.addEventListener('click', function () {
		shuffleOn = !shuffleOn;
		saveShuffle();
		syncShuffleBtn();
		if (shuffleOn) seedShuffleHistory(state.data);
		else shuffleNext = null;
		prefetchNeighbors();
	});

	// Keyboard
	document.addEventListener('keydown', function (e) {
		if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
		if (e.code === 'Space') { e.preventDefault(); if (state.playing) pause(); else resume(); }
		else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); navigate('next'); }
		else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); navigate('prev'); }
		else if (e.key === 'Escape') { if (closeBtn) closeBtn.click(); }
	});

	// Swipe (vertical carousel with prev/next peek)
	function hasNeighbor(dir) {
		if (shuffleOn) {
			if (dir === 'prev') return shuffleCursor > 0;
			return true;
		}
		var t = dir === 'next' ? (state.data && state.data.next) : (state.data && state.data.prev);
		return !!(t && t[0]);
	}

	function canSwipeFrom(target) {
		if (carousel.animating) return false;
		if (!target) return true;
		if (target.closest && target.closest('.reel-controls, button, a')) return false;

		// Allow vertical swipe on the end "next verse" overlay even if the panel has content.
		var overlayHint = target.closest ? target.closest('.reel-end-hint.is-overlay') : null;
		if (overlayHint) return true;

		if (defLine && target.closest && target.closest('#reel-bottom')) {
			if (defLine.scrollHeight > defLine.clientHeight + 4) return false;
		}
		if (endPanel && target.closest && target.closest('#reel-end-panel')) {
			// Keep verse swipe working in AI context word-meaning boxes (including headings/brackets).
			if (target.closest('.reel-end-wm, .reel-wm-item, .reel-wm-word, .reel-wm-meaning')) return true;
			if (endScroll && endScroll.scrollHeight > endScroll.clientHeight + 4) return false;
		}
		return true;
	}

	function onDown(e) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		if (!canSwipeFrom(e.target)) return;
		carousel.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dy: 0, axis: 0, vy: 0, lastY: e.clientY, lastT: Date.now(), target: e.target, captureEl: e.target };
	}

	function onMove(e) {
		var d = carousel.drag;
		if (!d || e.pointerId !== d.id) return;
		var dx = e.clientX - d.x;
		var dy = e.clientY - d.y;
		if (!d.axis) {
			if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
			d.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
			if (d.axis === 'y') {
				var cap = viewport || d.captureEl || e.target;
				try { cap.setPointerCapture(e.pointerId); } catch (err) {
					try { e.target.setPointerCapture(e.pointerId); } catch (err2) {}
				}
			}
		}
		if (d.axis !== 'y') return;
		if (e.cancelable) e.preventDefault();
		var now = Date.now();
		if (now > d.lastT) { d.vy = (e.clientY - d.lastY) / (now - d.lastT); d.lastY = e.clientY; d.lastT = now; }
		d.dy = dy;

		var dir = dy < 0 ? 'next' : 'prev';
		var h = paneHeight();
		var limit = h;
		var ty = dy;
		if (!hasNeighbor(dir)) {
			// edge resistance when there is no neighbor
			ty = dy * 0.18;
		} else {
			if (Math.abs(ty) > limit) ty = ty < 0 ? -limit : limit;
		}
		d.renderDy = ty;
		setTrackOffset(ty, false);
	}

	function finishCarouselCommit(dir, target) {
		carousel.animating = false;
		centerTrack(false);
		if (track) track.classList.remove('is-sliding');
		if (target) {
			goTo(target[0], target[1], true);
		}
	}

	function commitSwipe(dir) {
		var target = null;
		if (shuffleOn) {
			syncShuffleHistory();
			if (dir === 'prev') {
				if (shuffleCursor > 0) {
					shuffleCursor--;
					target = shuffleHistory[shuffleCursor];
				}
			} else {
				if (shuffleCursor < shuffleHistory.length - 1) {
					shuffleCursor++;
					target = shuffleHistory[shuffleCursor];
				} else {
					target = ensureShuffleNext();
					if (target && target[0]) {
						shuffleHistory.push([target[0], target[1]]);
						shuffleCursor = shuffleHistory.length - 1;
						shuffleNext = null;
					}
				}
			}
		} else {
			target = dir === 'next' ? (state.data && state.data.next) : (state.data && state.data.prev);
		}
		if (!target || !target[0]) { cancelSwipe(); return; }
		carousel.animating = true;
		var h = paneHeight();
		var to = dir === 'next' ? -h : h;
		if (reduced) {
			setTrackOffset(to, false);
			finishCarouselCommit(dir, target);
			return;
		}
		setTrackOffset(to, true);
		var done = false;
		var onEnd = function (ev) {
			if (done) return;
			if (ev && ev.target !== track) return;
			if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
			done = true;
			if (track) track.removeEventListener('transitionend', onEnd);
			finishCarouselCommit(dir, target);
		};
		if (track) track.addEventListener('transitionend', onEnd);
		setTimeout(function () { if (!done) { done = true; if (track) track.removeEventListener('transitionend', onEnd); finishCarouselCommit(dir, target); } }, 320);
	}

	function cancelSwipe() {
		carousel.animating = true;
		if (reduced) {
			centerTrack(false);
			carousel.animating = false;
			return;
		}
		setTrackOffset(0, true);
		var done = false;
		var onEnd = function (ev) {
			if (done) return;
			if (ev && ev.target !== track) return;
			if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
			done = true;
			if (track) track.removeEventListener('transitionend', onEnd);
			centerTrack(false);
			carousel.animating = false;
		};
		if (track) track.addEventListener('transitionend', onEnd);
		setTimeout(function () { if (!done) { done = true; if (track) track.removeEventListener('transitionend', onEnd); centerTrack(false); carousel.animating = false; } }, 320);
	}

	function onUp(e) {
		var d = carousel.drag;
		if (!d || e.pointerId !== d.id) return;
		carousel.drag = null;
		if (d.axis === 'y') {
			var dir = d.dy < 0 ? 'next' : 'prev';
			var commit = hasNeighbor(dir) && (Math.abs(d.dy) > paneHeight() * 0.22 || Math.abs(d.vy) > 0.35);
			if (commit) commitSwipe(dir);
			else cancelSwipe();
			return;
		}
		// tap/press on screen: left 10% = previous step, right 10% = next step, middle 80% = pause/play
		if (!d.axis) {
			var onEndOverlay = !!(d.target && d.target.closest && d.target.closest('.reel-end-hint.is-overlay'));
			if (onEndOverlay) return;
			var rect = viewport ? viewport.getBoundingClientRect() : null;
			var tapX = (typeof d.x === 'number') ? d.x : e.clientX;
			var left, width;
			if (rect && rect.width) {
				left = rect.left;
				width = rect.width;
			} else {
				left = 0;
				width = window.innerWidth || 1;
			}
			var rel = (tapX - left) / width;
			if (rel < 0.1) {
				skipPrevPart();
			} else if (rel > 0.9) {
				skipNextPart();
			} else {
				if (state.playing) pause(); else resume();
			}
		}
	}

	if (viewport) {
		viewport.addEventListener('pointerdown', onDown);
		window.addEventListener('pointermove', onMove, { passive: false });
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	window.addEventListener('popstate', function (e) {
		var st = e.state;
		if (st && st.surah && st.verse) goTo(st.surah, st.verse, false);
		else {
			var m = /^\/reel\/(\d+)\/(\d+)/.exec(location.pathname);
			if (m) goTo(parseInt(m[1], 10), parseInt(m[2], 10), false);
		}
	});

	function startReel() {
		requestWakeSafe();
		enterInitialOverview(true);
	}

	function maybeShowHint() {
		var seen = false;
		try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) {}
		if (!seen && hintOverlay) {
			hintActive = true;
			hintOverlay.hidden = false;
			hintOverlay.setAttribute('aria-hidden', 'false');
			enterInitialOverview(false);
			return true;
		}
		return false;
	}

	/* ---------- keep the screen on (like prayer time) ---------- */
	// 1) Screen Wake Lock API where available.
	// 2) Fallback: tiny silent looping video (classic trick; browsers may need a tap).
	var WAKE_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANIbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAnJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHqbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABlW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVVzdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAe/+EAF2dCwB7ZBCbARAAAAwAEAAADACA8WLkgAQAFaMuDyyAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAALlAAAC5QAAAAYc3R0cwAAAAAAAAABAAAACAAAEAAAAAAYc3RzcwAAAAAAAAACAAAAAQAAAAUAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAgAAAABAAAANHN0c3oAAAAAAAAAAAAAAAgAAAKMAAAACgAAAAsAAAAKAAAAGwAAAAoAAAALAAAACgAAABRzdGNvAAAAAAAAAAEAAAN4AAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAu1tZGF0AAACbQYF//9p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9NCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00IHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABdliIQEvJigADijJycnXXXXXXXXXXXXgAAAAAZBmjgJeEYAAAAHQZpUAl4RgAAAAAZBmmAS8IwAAAAXZYiCAU8mKAAP78nJyddddddddddddeAAAAAGQZo4CXhGAAAAB0GaVAI+EYAAAAAGQZpgEPCM';
	var WAKE_WEBM = 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAK4EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggKQ7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECfQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYhDZsf96HcQ4JyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhA7msoDgibCBQLqBQJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYhDZsf96HcQ4GfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVA6+eBAKOqgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/q1CAo5aBAPoA0QEAARAQABgAGFgv9AAIjoAAo5aBAfQA0QEAARAQABgAGFgv9AAIjoAAo5aBAu4A0QEAARAQABgAGFgv9AAIjoAAo6qBA+iA8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v+rUICjloEE4gDRAQABEBAAGAAYWC/0AAiOgACjloEF3ADRAQABEBAAGAAYWC/0AAiOgACjloEG1gDRAQABEBAAGAAYWC/0AAiOgAAcU7tro7uPs4EAt4r3gQHxggGf8IEDu5CzggPot4r3gQHxggGf8IF3';
	var wakeVideo = document.getElementById('reel-wake-video');
	var wakeLock = null;
	var wakeSupported = 'wakeLock' in navigator;
	var wakePending = false;
	var videoOn = false;

	function startVideoWake() {
		if (!wakeVideo) return;
		if (!wakeVideo.src) wakeVideo.src = (wakeVideo.canPlayType && wakeVideo.canPlayType('video/mp4')) ? WAKE_MP4 : WAKE_WEBM;
		wakeVideo.muted = true;
		wakeVideo.setAttribute('playsinline', '');
		wakeVideo.setAttribute('webkit-playsinline', '');
		wakeVideo.loop = true;
		try {
			var p = wakeVideo.play();
			if (p && p.then) {
				p.then(function () { videoOn = true; }).catch(function () { videoOn = false; });
			} else {
				videoOn = !wakeVideo.paused;
			}
		} catch (e) { videoOn = false; }
	}
	function stopVideoWake() {
		if (!wakeVideo) return;
		try { wakeVideo.pause(); } catch (e) {}
		videoOn = false;
	}

	function requestWakeSafe() {
		if (document.hidden) return;
		if (wakeSupported) {
			if (wakeLock && !wakeLock.released) return;
			if (wakePending) return;
			wakePending = true;
			try {
				navigator.wakeLock.request('screen').then(function (lock) {
					wakeLock = lock;
					wakePending = false;
					lock.addEventListener('release', function () { wakeLock = null; });
					stopVideoWake();
				}, function () {
					wakePending = false;
					// Native lock unavailable (or no user activation): keep the
					// screen on with the silent-video fallback (important on iOS).
					startVideoWake();
				});
			} catch (e) {
				wakePending = false;
				startVideoWake();
			}
			return;
		}
		// No Screen Wake Lock API: use the silent-video fallback (needs a
		// user gesture on iOS, so we also retry on every interaction).
		startVideoWake();
	}
	function releaseWake() {
		if (wakeLock) { try { wakeLock.release().catch(function () {}); } catch (e) {} wakeLock = null; }
		stopVideoWake();
	}

	document.addEventListener('visibilitychange', function () {
		if (!document.hidden) requestWakeSafe();
	});
	window.addEventListener('pagehide', releaseWake);
	window.addEventListener('beforeunload', releaseWake);
	['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown'].forEach(function (ev) {
		document.addEventListener(ev, function () { requestWakeSafe(); }, true);
	});
	setInterval(function () {
		if (wakeSupported && !document.hidden) requestWakeSafe();
	}, 30000);

	if (hintGotIt) {
		hintGotIt.addEventListener('click', function () {
			try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
			if (hintOverlay) {
				hintOverlay.hidden = true;
				hintOverlay.setAttribute('aria-hidden', 'true');
			}
			hintActive = false;
			requestWakeSafe();
			startReel();
		});
	}

	// Init
	try { history.replaceState({ surah: state.data.surah, verse: state.data.verse }, '', location.pathname); } catch (e) {}
	buildProgressPills();
	setProgressFilledUpTo(0);
	resetVerseArea();
	clearMiddle({ immediate: true });
	clearBottom();
	showEnd(false);
	centerTrack(false);
	if (actualTranslationEl) actualTranslationEl.textContent = (state.data && state.data.translation) || '';
	seedShuffleHistory(state.data);
	prefetchNeighbors();
	emitVerse(state.data);
	requestWakeSafe();
	if (!maybeShowHint()) {
		startReel();
	} else {
		// Opening scene is already rendered (paused behind hint) so the reel is never empty.
	}

	var fitTimer = null;
	window.addEventListener('resize', function () {
		if (fitTimer) clearTimeout(fitTimer);
		fitTimer = setTimeout(function () { scheduleTopFit(); scheduleMiddleFit(); fitOpeningSoon(); if (!carousel.animating) centerTrack(false); }, 80);
	});

	// The reel viewport can settle after the first script pass (dvh, fonts,
	// safe areas). Refit whenever it actually changes size so the opening
	// scene always fills the screen.
	if (typeof ResizeObserver === 'function' && viewport) {
		try {
			var openingRO = new ResizeObserver(function () { scheduleOpeningFit(); });
			openingRO.observe(viewport);
		} catch (e) {}
	}
	if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
		document.fonts.ready.then(function () { scheduleMiddleFit(); fitOpeningSoon(); }, function () {});
	}
	fitOpeningSoon();
})();