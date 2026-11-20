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
	var refNum = document.getElementById('reel-ref-num');
	var wordAr = document.getElementById('reel-word-ar');
	var wordMeaning = document.getElementById('reel-word-meaning');
	var chipsEl = document.getElementById('reel-chips');
	var defHead = document.getElementById('reel-def-head');
	var defText = document.getElementById('reel-def-text');
	var playBtn = document.getElementById('reel-play');
	var playIcon = document.getElementById('reel-play-icon');
	var prevPartBtn = document.getElementById('reel-prev-part');
	var nextPartBtn = document.getElementById('reel-next-part');
	var shareBtn = document.getElementById('reel-share');
	var closeBtn = document.getElementById('reel-close');
	var bottom = document.getElementById('reel-bottom');
	var endPanel = document.getElementById('reel-end-panel');
	var endScroll = document.getElementById('reel-end-scroll');
	var endContext = document.getElementById('reel-end-context');
	var endWm = document.getElementById('reel-end-wm');
	var endHint = document.getElementById('reel-end-hint');

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
		var d = state.data;
		if (d.prev && d.prev[0]) fetchVerse(d.prev[0], d.prev[1]).catch(function () {});
		if (d.next && d.next[0]) fetchVerse(d.next[0], d.next[1]).catch(function () {});
		updateNeighborPreviews();
	}

	function isAtBeginning() {
		return state.phase === 'intro' && state.idx === 0;
	}

	function updatePartButtons() {
		if (prevPartBtn) prevPartBtn.disabled = isAtBeginning();
		if (nextPartBtn) nextPartBtn.disabled = state.phase === 'end-done';
	}

	function setPlaying(on) {
		state.playing = !!on;
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
		if (verseBox) verseBox.style.fontSize = v + 'rem';
		if (verseMeaning) verseMeaning.style.fontSize = m + 'rem';
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
		return false;
	}

	function fitTopToContainer() {
		var top = verseBox ? verseBox.closest('.reel-top') : null;
		if (!top || !verseBox) return;
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
		if (topOverflows(top) && verseMeaning) {
			verseMeaning.style.marginTop = '2px';
			verseMeaning.style.lineHeight = '1.3';
		} else if (verseMeaning) {
			verseMeaning.style.marginTop = '';
			verseMeaning.style.lineHeight = '';
		}
	}

	function scheduleTopFit() {
		fitTopToContainer();
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitTopToContainer);
	}

	function resetVerseArea() {
		if (verseBox) verseBox.innerHTML = '';
		if (verseMeaning) verseMeaning.innerHTML = '';
		if (verseBox) verseBox.style.lineHeight = '';
		if (verseMeaning) { verseMeaning.style.marginTop = ''; verseMeaning.style.lineHeight = ''; }
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

	function revealPlaced(i) {
		var sp = getSpan(i);
		var mp = getMeaningSpan(i);
		if (sp) { sp.classList.remove('is-hidden-target', 'is-active'); sp.classList.add('is-read', 'rv-landed'); }
		if (mp) { mp.classList.remove('is-hidden-target', 'is-active'); mp.classList.add('is-read', 'rv-landed'); }
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
			if (chipsEl) { chipsEl.innerHTML = ''; chipsEl.style.display = ''; }
			return;
		}
		// fade out arabic word and blue translation (and clear chips)
		if (wordAr && wordAr.textContent) { wordAr.classList.remove('is-appearing'); wordAr.classList.add('is-fading'); }
		if (wordMeaning && wordMeaning.style.visibility !== 'hidden' && (wordMeaning.textContent || '').trim()) { wordMeaning.classList.remove('is-appearing'); wordMeaning.classList.add('is-fading'); }
		if (chipsEl) { chipsEl.innerHTML = ''; }
		midClearTimer = setTimeout(function () {
			midClearTimer = null;
			if (wordAr) { wordAr.classList.remove('is-fading', 'is-appearing'); wordAr.style.opacity = ''; wordAr.style.transform = ''; wordAr.textContent = ''; }
			if (wordMeaning) { wordMeaning.classList.remove('is-fading', 'is-appearing'); wordMeaning.style.opacity = ''; wordMeaning.style.transform = ''; wordMeaning.textContent = '\u00A0'; wordMeaning.style.visibility = 'hidden'; }
		}, 220);
	}

	function clearBottom() {
		if (defHead) defHead.innerHTML = '';
		if (defText) defText.textContent = '';
	}

	function resetEndPanel() {
		if (stage) stage.classList.remove('is-ended');
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
		// ended layout: top 25% keeps built verse/translation, lower 75% shows end panel
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
		function next() {
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
		if (nameEl) nameEl.textContent = '';
		if (numEl) numEl.textContent = '';
		if (vEl) vEl.innerHTML = '';
		if (mEl) mEl.innerHTML = '';
	}

	function renderPreview(dir, data) {
		var pane = dir === 'prev' ? prevPane : nextPane;
		if (!pane) return;
		var target = dir === 'prev' ? (state.data && state.data.prev) : (state.data && state.data.next);
		var nameEl = pane.querySelector(dir === 'prev' ? '.reel-prev-name' : '.reel-next-name');
		var numEl = pane.querySelector(dir === 'prev' ? '.reel-prev-num' : '.reel-next-num');
		var vEl = pane.querySelector(dir === 'prev' ? '.reel-prev-verse' : '.reel-next-verse');
		var mEl = pane.querySelector(dir === 'prev' ? '.reel-prev-meaning' : '.reel-next-meaning');

		// Render as cleared/initial reel state so swipe reveal/commit stays seamless
		// (new reel page starts cleared before intro/word-by-word begins).
		if (nameEl) nameEl.textContent = data ? (data.name || '') : '';
		if (numEl) numEl.textContent = data ? (data.surah + ':' + data.verse) : ((target && target[0]) ? (target[0] + ':' + target[1]) : '');
		if (vEl) vEl.innerHTML = '';
		if (mEl) mEl.innerHTML = '';
	}

	function updateNeighborPreviews() {
		var prevTarget = state.data && state.data.prev;
		var nextTarget = state.data && state.data.next;
		if (prevTarget && prevTarget[0]) {
			var pk = key(prevTarget[0], prevTarget[1]);
			renderPreview('prev', cache[pk] || null);
		} else {
			renderPreview('prev', null);
		}
		if (nextTarget && nextTarget[0]) {
			var nk = key(nextTarget[0], nextTarget[1]);
			renderPreview('next', cache[nk] || null);
		} else {
			renderPreview('next', null);
		}
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
			return {
				headHtml: '<span class="root-ar">' + escapeHtml(root.ar || word.root || '') + '</span>' +
					(root.meaning ? ' — ' + escapeHtml(root.meaning) : ''),
				text: String(root.text || '').replace(/<br\s*\/?>/gi, '\n')
			};
		}
		return {
			headHtml: '<span class="root-ar">' + escapeHtml(word.lemma || word.root || word.ar || '') + '</span>',
			text: word.meaning || ''
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
		if (target === defText && defText) defText.scrollTop = defText.scrollHeight;
		if (state.phase === 'end-wm-type' && endScroll) endScroll.scrollTop = endScroll.scrollHeight;
		if (state.phase === 'end-context' && endScroll) endScroll.scrollTop = endScroll.scrollHeight;
		if (state.twPos < state.twText.length) {
			state.twTimer = setTimeout(typeStep, ms(18));
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
		state.twTimer = setTimeout(typeStep, ms(18));
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
			if (state.playing) startPhase('fly');
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
				if (endWm) endWm.innerHTML = '';
				state.endWmIdx++;
			} else if (p === 'end-wm-clear' || p === 'end-wm-start') {
				// idx positioned for next/first; showNextEndWordMeaning will handle
			}
			if (endContext) endContext.textContent = '';
			leaveEndDone();
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
			if (ctx) { leaveEndDone(); setPlaying(true); beginEndContextSequence(); }
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
				else { leaveEndDone(); setPlaying(true); beginEndContextSequence(); }
			}
			return;
		}
		if (p === 'end-wm-to-context-wait') {
			if (wms.length) { showEndWordMeaningAt(wms.length - 1); }
			else {
				var last3 = (state.data.words || []).length - 1;
				if (last3 >= 0) enterWordMeaningSegment(last3);
				else { leaveEndDone(); setPlaying(true); beginEndContextSequence(); }
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
				state.wordmeaningStep = 1;
				schedule(t.meaning, function () { startBreakdown(); });
			});
		} else if (phase === 'rootmeaning') {
			var def = defForWord(w);
			if (defHead) defHead.innerHTML = def.headHtml;
			if (bottom) bottom.scrollTop = 0;
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
				startPhase('fly');
			} else if (state.twText) {
				resumeTypewriter();
			} else {
				// typewriter not started yet (e.g. paused immediately)
				var w = (state.data.words || [])[state.idx] || {};
				var def = defForWord(w);
				if (defHead) defHead.innerHTML = def.headHtml;
				if (bottom) bottom.scrollTop = 0;
				startTypewriter(def.text, defText);
			}
			return;
		}
		if (state.phase === 'rootmeaning-done') {
			startPhase('fly');
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
		setPlaying(true);
		startIntro();
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
		cache[key(data.surah, data.verse)] = data;
		updateMeta(data);
		resetVerseArea();
		clearMiddle({ immediate: true });
		clearBottom();
		showEnd(false);
		setPlaying(true);
		startIntro();
		// Keep a single reel history entry to avoid stacking; URL follows current verse.
		try { history.replaceState({ surah: data.surah, verse: data.verse }, '', '/reel/' + data.surah + '/' + data.verse); } catch (e) {}
		emitVerse(data);
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

		if (defText && target.closest && target.closest('#reel-bottom')) {
			if (defText.scrollHeight > defText.clientHeight + 4) return false;
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
		var target = dir === 'next' ? (state.data && state.data.next) : (state.data && state.data.prev);
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

	// Init
	try { history.replaceState({ surah: state.data.surah, verse: state.data.verse }, '', location.pathname); } catch (e) {}
	resetVerseArea();
	clearMiddle({ immediate: true });
	clearBottom();
	showEnd(false);
	centerTrack(false);
	setPlaying(true);
	startIntro();
	prefetchNeighbors();
	emitVerse(state.data);

	var fitTimer = null;
	window.addEventListener('resize', function () {
		if (fitTimer) clearTimeout(fitTimer);
		fitTimer = setTimeout(function () { scheduleTopFit(); if (!carousel.animating) centerTrack(false); }, 80);
	});
})();