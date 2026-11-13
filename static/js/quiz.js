/* Aayatun Quran Quiz — client for /quiz.
   The server ships the answer index (a casual quiz, not an exam). */
(function () {
	'use strict';

	var TIME_PER_Q = 30;           // seconds
	var HISTORY_KEY = 'aayatun_quiz_history_v1';
	var MAX_HISTORY = 20;
	var ASPECT_LABEL = {
		translation: 'Translation',
		word_meaning: 'Word meaning',
		grammar: 'Grammar',
		tafsir: 'Tafsir',
		ai_context: 'AI context'
	};

	var tokenMeta = document.querySelector('meta[name="aayatun-api-token"]');
	var token = tokenMeta ? tokenMeta.content : '';

	function byId(id) { return document.getElementById(id); }

	var views = {
		start: byId('quiz-start'),
		round: byId('quiz-round'),
		result: byId('quiz-result')
	};

	function showView(name) {
		Object.keys(views).forEach(function (key) {
			if (views[key]) views[key].hidden = key !== name;
		});
		var hud = byId('quiz-score-hud');
		if (hud) hud.hidden = name === 'start';
		window.scrollTo(0, 0);
	}

	var state = {
		session: null,
		questions: [],
		index: 0,
		score: 0,
		points: 0,
		stepAnswers: [],
		timerId: null,
		timerDuration: 0,
		endsAt: 0,
		startedAt: 0,
		locked: false,
		hintUsed: false,
		lifelines: { addTime: true, fiftyFifty: true }
	};

	/* ------------------------------ history ------------------------------ */

	function loadHistory() {
		try {
			var h = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
			return Array.isArray(h) ? h : [];
		} catch (e) {
			return [];
		}
	}

	function saveHistory(history) {
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
		} catch (e) { /* storage full or unavailable: history just won't persist */ }
	}

	function clearHistory() {
		try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
		renderStats();
	}

	function fmtDate(iso) {
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				day: 'numeric', month: 'short', year: 'numeric'
			});
		} catch (e) {
			return '';
		}
	}

	function renderStats() {
		var history = loadHistory();
		var total = history.reduce(function (m, e) { return Math.max(m, e.total || 0); }, 0) || 5;
		var best = history.reduce(function (m, e) { return Math.max(m, e.score || 0); }, 0);
		byId('quiz-attempts').textContent = String(history.length);
		byId('quiz-best').textContent = history.length ? best + '/' + total : '–';

		var wrap = byId('quiz-history');
		var list = byId('quiz-history-list');
		if (!history.length) {
			wrap.hidden = true;
			return;
		}
		wrap.hidden = false;
		list.innerHTML = '';
		history.slice(0, MAX_HISTORY).forEach(function (entry) {
			var row = document.createElement('div');
			row.className = 'quiz-history-row';

			var score = document.createElement('div');
			score.className = 'quiz-history-score';
			score.textContent = (entry.score || 0) + '/' + (entry.total || total);
			row.appendChild(score);

			var meta = document.createElement('div');
			meta.className = 'quiz-history-meta';
			meta.textContent = fmtDate(entry.date) +
				(entry.durationSec ? ' · ' + Math.round(entry.durationSec) + 's' : '');
			row.appendChild(meta);

			var dots = document.createElement('div');
			dots.className = 'quiz-history-dots';
			(entry.correct || []).forEach(function (ok, i) {
				var dot = document.createElement('span');
				var aspect = (entry.aspects || [])[i];
				var hinted = !!(entry.hints || [])[i];
				var label = hinted ? 'hint' : (ok ? 'correct' : 'incorrect');
				dot.className = 'quiz-dot ' + label;
				dot.title = (hinted ? 'Hint used' : ok ? 'Correct' : 'Missed') +
					' · ' + (ASPECT_LABEL[aspect] || 'Question');
				dots.appendChild(dot);
			});
			row.appendChild(dots);
			list.appendChild(row);
		});
	}

	/* 200 points per correct answer. On a correct tap, number tokens fly
	   from the answer across to the score HUD (top-left), the chip bumps,
	   and the displayed total counts up. */
	var POINTS_PER_ANSWER = 200;
	var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	function flyPoints(fromEl) {
		if (reducedMotion || !fromEl || !fromEl.getBoundingClientRect) return;
		var r = fromEl.getBoundingClientRect();
		var hudEl = byId('quiz-score-hud');
		if (!hudEl) return;
		var h = hudEl.getBoundingClientRect();
		var originX = r.left + r.width / 2;
		var originY = r.top + r.height / 2;
		var targetX = h.left + h.width / 2;
		var targetY = h.top + h.height / 2;
		var chips = [[0, '1.1rem', 0], [-36, '.78rem', 80], [36, '.78rem', 80]];
		chips.forEach(function (cfg) {
			var el = document.createElement('span');
			el.className = 'flying-point';
			el.textContent = '+' + POINTS_PER_ANSWER;
			el.style.left = (originX + cfg[0] - 24) + 'px';
			el.style.top = (originY - 14) + 'px';
			el.style.fontSize = cfg[1];
			document.body.appendChild(el);
			var dx = targetX - (originX + cfg[0]);
			var dy = targetY - originY;
			try {
				el.animate([
					{ transform: 'translate(0, 0) scale(1)', opacity: 0 },
					{ transform: 'translate(0, -12px) scale(1.08)', opacity: 1, offset: 0.22 },
					{ transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(.28)', opacity: 0.9, offset: 0.88 },
					{ transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(.2)', opacity: 0 }
				], { duration: 700, delay: cfg[2], easing: 'cubic-bezier(.17,.84,.44,1)', fill: 'forwards' });
				setTimeout(function () { el.remove(); }, 750 + cfg[2]);
			} catch (e) {
				el.remove();
			}
		});
	}

	function countUpPoints(from, to) {
		var el = byId('quiz-score-num');
		if (!el) return;
		if (reducedMotion || from === to) { el.textContent = String(to); return; }
		var start = null, dur = 550;
		function tick(t) {
			if (!start) start = t;
			var p = Math.min(1, (t - start) / dur);
			var eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
			el.textContent = String(Math.round(from + (to - from) * eased));
			if (p < 1) requestAnimationFrame(tick);
			else el.textContent = String(to);
		}
		requestAnimationFrame(tick);
	}

	function addPoints(n, fromEl) {
		var from = state.points;
		state.points += n;
		flyPoints(fromEl);
		countUpPoints(from, state.points);
		var hud = byId('quiz-score-hud');
		if (hud) {
			hud.classList.remove('bump');
			void hud.offsetWidth;
			hud.classList.add('bump');
			setTimeout(function () { hud.classList.remove('bump'); }, 500);
		}
	}

	/* ------------------------------ round ------------------------------- */

	function currentQuestion() {
		return state.questions[state.index];
	}

	function renderDots() {
		var wrap = byId('quiz-dots');
		wrap.innerHTML = '';
		for (var i = 0; i < state.questions.length; i++) {
			var dot = document.createElement('span');
			dot.className = 'quiz-dot';
			if (i < state.stepAnswers.length) {
				dot.classList.add(state.stepAnswers[i].ok ? 'done' : 'missed');
			} else if (i === state.index) {
				dot.classList.add('current');
			}
			wrap.appendChild(dot);
		}
	}

	function clearTimer() {
		if (state.timerId) {
			clearInterval(state.timerId);
			state.timerId = null;
		}
	}

	/* The quiz advances only when the learner presses Next — never on a timer. */
	function advance() {
		clearTimer();
		state.index += 1;
		if (state.index >= state.questions.length) {
			finishRound();
		} else {
			renderQuestion();
		}
	}

	function renderQuestion() {
		var q = currentQuestion();
		state.locked = false;
		state.hintUsed = false;
		state.timerDuration = TIME_PER_Q * 1000;
		hideFeedbackModal();

		byId('quiz-progress').textContent =
			'Question ' + (state.index + 1) + ' of ' + state.questions.length;

		var aspect = byId('quiz-aspect');
		aspect.textContent = ASPECT_LABEL[q.aspect] || q.aspect;
		aspect.className = 'quiz-aspect ' + q.aspect;
		byId('quiz-difficulty').textContent = q.difficulty;

		byId('quiz-arabic').textContent = state.session.arabic || '';
		byId('quiz-translation').textContent = state.session.translation || '';

		byId('quiz-prompt').textContent = q.prompt;

		var options = byId('quiz-options');
		options.innerHTML = '';
		q.choices.forEach(function (choice, i) {
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'quiz-option';
			btn.dataset.index = String(i);
			btn.textContent = choice;
			btn.addEventListener('click', function () { chooseOption(btn, i); });
			options.appendChild(btn);
		});
		renderDots();
		byId('quiz-hint').hidden = true;
		byId('quiz-hint').textContent = q.hint || '';
		var hintBtn = byId('quiz-hint-btn');
		hintBtn.disabled = false;
		hintBtn.style.visibility = 'visible';

		startTimer();
		updateLifelines();
	}

	/* The two lifelines: +30s (extends the running timer) and 50/50
	   (eliminates two wrong choices). One use of each per session. */
	function shuffleArr(arr) {
		var a = arr.slice();
		for (var i = a.length - 1; i > 0; i--) {
			var j = Math.floor(Math.random() * (i + 1));
			var t = a[i];
			a[i] = a[j];
			a[j] = t;
		}
		return a;
	}

	function updateLifelines() {
		var at = byId('quiz-add-time');
		var ff = byId('quiz-fifty-fifty');
		if (at) {
			at.disabled = !state.lifelines.addTime || state.locked;
			at.classList.toggle('used', !state.lifelines.addTime);
			at.setAttribute('aria-pressed', String(!state.lifelines.addTime));
		}
		if (ff) {
			ff.disabled = !state.lifelines.fiftyFifty || state.locked;
			ff.classList.toggle('used', !state.lifelines.fiftyFifty);
			ff.setAttribute('aria-pressed', String(!state.lifelines.fiftyFifty));
		}
	}

	function startTimer() {
		clearTimer();
		var duration = state.timerDuration;
		state.endsAt = Date.now() + duration;
		var bar = byId('quiz-timer-bar');
		var text = byId('quiz-timer-text');
		bar.classList.remove('low');
		bar.style.width = '100%';
		text.textContent = Math.ceil(duration / 1000) + 's';
		state.timerId = setInterval(function () {
			var remain = state.endsAt - Date.now();
			if (remain <= 0) {
				remain = 0;
				clearTimer();
				timeUp();
			}
			var pct = Math.max(0, Math.min(100, (remain / duration) * 100));
			bar.style.width = pct + '%';
			text.textContent = Math.ceil(remain / 1000) + 's';
			if (remain <= 5000) bar.classList.add('low');
		}, 100);
	}

	function showRef() {
		if (!state.session) return;
		var ref = byId('quiz-ref');
		ref.innerHTML = '';
		var a = document.createElement('a');
		a.href = '/' + state.session.surah + '/' + state.session.verse;
		a.textContent = state.session.surah + ':' + state.session.verse +
			' · ' + (state.session.surah_name || '');
		ref.appendChild(a);
	}

	function lockAndMark(chosenIndex) {
		var q = currentQuestion();
		var buttons = byId('quiz-options').querySelectorAll('.quiz-option');
		buttons.forEach(function (btn, i) {
			btn.disabled = true;
			if (i === q.answer) btn.classList.add('correct');
			else if (chosenIndex !== null && i === chosenIndex) btn.classList.add('wrong');
		});
	}

	function chooseOption(btn, index) {
		if (state.locked) return;
		state.locked = true;
		clearTimer();
		updateLifelines();

		var q = currentQuestion();
		var ok = index === q.answer;
		if (ok) {
			state.score += 1;
			addPoints(POINTS_PER_ANSWER, btn);
		}

		lockAndMark(index);
		showFeedback(ok ? 'Correct!' : 'Not quite.', index);
		state.stepAnswers.push({
			prompt: q.prompt,
			aspect: q.aspect,
			ok: ok,
			chosen: ok ? null : q.choices[index],
			correct: q.choices[q.answer],
			explanation: q.explanation,
			difficulty: q.difficulty,
			hintUsed: state.hintUsed
		});
		renderDots();
	}

	function timeUp() {
		if (state.locked) return;
		state.locked = true;
		updateLifelines();
		var q = currentQuestion();
		lockAndMark(null);
		showFeedback('Time’s up!', null);
		state.stepAnswers.push({
			prompt: q.prompt,
			aspect: q.aspect,
			ok: false,
			chosen: null,
			correct: q.choices[q.answer],
			explanation: q.explanation,
			difficulty: q.difficulty,
			hintUsed: state.hintUsed
		});
		renderDots();
	}

	/* Answer feedback as a floating card (like the counter page's install sheet):
	   dimmed, blurred backdrop, soft card, dismissable only toward the next question. */
	function showFeedbackModal(text, ok, explanation) {
		var overlay = byId('quiz-feedback');
		if (!overlay) return;
		overlay.classList.remove('ok', 'bad');
		overlay.classList.add(ok ? 'ok' : 'bad');
		byId('quiz-feedback-icon').textContent = ok ? '✓' : '✕';
		byId('quiz-feedback-verdict').textContent = text;
		byId('quiz-feedback-explanation').textContent = explanation || '';
		overlay.hidden = false;
		document.documentElement.classList.add('quiz-feedback-open');
		// force a reflow so the entrance transition runs from the reset state
		void overlay.offsetWidth;
		overlay.classList.add('show');
		var next = byId('quiz-next');
		if (next) next.focus();
	}

	function hideFeedbackModal() {
		var overlay = byId('quiz-feedback');
		if (!overlay) return;
		overlay.classList.remove('show');
		overlay.hidden = true;
		document.documentElement.classList.remove('quiz-feedback-open');
	}

	function showFeedback(verdictText, chosenIndex) {
		var q = currentQuestion();
		var okVerdict = verdictText === 'Correct!';
		byId('quiz-hint-btn').style.visibility = 'hidden';
		/* The hint rides along with the feedback: seeing the explanation
		   alongside the hint cements what the verse was getting at. */
		var hintEl = byId('quiz-hint');
		hintEl.innerHTML = '';
		var strong = document.createElement('strong');
		strong.textContent = 'Hint: ';
		hintEl.appendChild(strong);
		hintEl.appendChild(document.createTextNode(q.hint || ''));
		hintEl.hidden = false;

		/* On misses, spell out the two choices so the learner can compare them:
		   their own pick (hidden when the clock ran out) and the right one. */
		var answersBox = byId('quiz-feedback-answers');
		var yourRow = answersBox.querySelector('.quiz-feedback-answer.wrong');
		if (okVerdict) {
			answersBox.hidden = true;
		} else {
			answersBox.hidden = false;
			yourRow.style.display = chosenIndex === null || chosenIndex === undefined ? 'none' : '';
			byId('quiz-answer-yours').textContent =
				chosenIndex === null || chosenIndex === undefined ? '' : q.choices[chosenIndex];
			byId('quiz-answer-right').textContent = q.choices[q.answer];
		}

		showFeedbackModal(verdictText, okVerdict, q.explanation);

		byId('quiz-next').innerHTML =
			state.index + 1 >= state.questions.length
				? 'See result <i class="right arrow icon" aria-hidden="true"></i>'
				: 'Next <i class="right arrow icon" aria-hidden="true"></i>';
	}

	/* ------------------------------ result ------------------------------ */

	function finishRound() {
		clearTimer();
		hideFeedbackModal();
		var total = state.questions.length;
		var pct = total ? state.score / total : 0;
		var durationSec = Math.round((Date.now() - state.startedAt) / 1000);

		var difficulties = state.stepAnswers.map(function (a) { return a.difficulty; });
		var aspects = state.stepAnswers.map(function (a) { return a.aspect; });
		var hints = state.stepAnswers.map(function (a) { return !!a.hintUsed; });
		var correct = state.stepAnswers.map(function (a) { return a.ok; });
		var points = byId('quiz-points');
		if (points) points.textContent = String(state.points);
		var history = loadHistory();
		history.unshift({
			score: state.score,
			total: total,
			date: new Date().toISOString(),
			durationSec: durationSec,
			difficulties: difficulties,
			aspects: aspects,
			hints: hints,
			correct: correct,
			points: state.points
		});
		saveHistory(history);

		byId('quiz-final-score').textContent = state.score + '/' + total;
		byId('quiz-final-pct').textContent = Math.round(pct * 100) + '%';

		var ring = byId('quiz-ring');
		var C = 326.7; // 2 * pi * 52
		ring.style.strokeDashoffset = String(C * (1 - pct));
		ring.classList.remove('mid', 'low');
		if (pct < 0.4) ring.classList.add('low');
		else if (pct < 0.7) ring.classList.add('mid');

		var tag = byId('quiz-result-tag');
		if (pct >= 0.9) tag.textContent = 'Outstanding — you read with care.';
		else if (pct >= 0.7) tag.textContent = 'Great work.';
		else if (pct >= 0.5) tag.textContent = 'Not bad — keep going.';
		else if (pct >= 0.3) tag.textContent = 'Room to grow.';
		else tag.textContent = 'Every scholar was once a student.';

		var review = byId('quiz-review');
		review.innerHTML = '';
		state.stepAnswers.forEach(function (a) {
			var item = document.createElement('div');
			item.className = 'quiz-review-item ' + (a.ok ? 'ok' : 'bad');

			var icon = document.createElement('i');
			icon.className = 'quiz-review-icon icon ' + (a.ok ? 'check circle' : 'times circle');
			icon.setAttribute('aria-hidden', 'true');

			var body = document.createElement('div');
			var line = document.createElement('div');
			line.textContent = a.prompt;
			var refLine = document.createElement('div');
			refLine.className = 'quiz-review-ref';
			var link = document.createElement('a');
			var ses = state.session || {};
			link.href = '/' + ses.surah + '/' + ses.verse;
			link.textContent = ses.surah + ':' + ses.verse;
			refLine.appendChild(link);
			var aspectTag = document.createElement('span');
			aspectTag.textContent = ' · ' + (ASPECT_LABEL[a.aspect] || a.aspect);
			refLine.appendChild(aspectTag);
			if (!a.ok) {
				var fix = document.createElement('span');
				fix.textContent = ' — answer: ' + a.correct;
				refLine.appendChild(fix);
			}

			body.appendChild(line);
			body.appendChild(refLine);
			item.appendChild(icon);
			item.appendChild(body);
			review.appendChild(item);
		});

		var shareBtn = byId('quiz-share-btn');
		shareBtn.onclick = function () {
			if (window.AayatunShare && window.AayatunShare.shareQuiz) {
				window.AayatunShare.shareQuiz({ score: state.score, total: total }, shareBtn);
			}
		};

		showView('result');
		renderStats();
	}

	/* ------------------------------ fetch ------------------------------- */

	function fetchSession() {
		return fetch('/api/v1/quiz/session', {
			credentials: 'same-origin',
			headers: token ? { 'X-Aayatun-Token': token } : {}
		}).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		});
	}

	function startQuiz() {
		fetchSession().then(function (session) {
			var questions = session && Array.isArray(session.questions) ? session.questions : [];
			if (questions.length !== 5) {
				if (byId('quiz-start-note')) {
					byId('quiz-start-note').textContent =
						'Could not load a quiz session right now — please try again in a moment.';
				}
				return;
			}
			state.session = session;
			state.questions = questions;
			state.index = 0;
			state.score = 0;
			state.stepAnswers = [];
			state.lifelines = { addTime: true, fiftyFifty: true };
			state.points = 0;
			var scoreNum = byId('quiz-score-num');
			if (scoreNum) scoreNum.textContent = '0';
			state.startedAt = Date.now();
			showRef();
			showView('round');
			renderQuestion();
		}).catch(function () {
			if (byId('quiz-start-note')) {
				byId('quiz-start-note').textContent =
					'Could not load a quiz session right now — please try again in a moment.';
			}
		});
	}

	/* ------------------------------ wiring ------------------------------ */

	byId('quiz-start-btn').addEventListener('click', startQuiz);

	byId('quiz-hint-btn').addEventListener('click', function () {
		var hint = byId('quiz-hint');
		hint.hidden = !hint.hidden;
		if (!hint.hidden) state.hintUsed = true;
	});

	// Lifelines. +30s: the running timer gains half a minute — the bar flashes
	// green, a badge floats up from the timer and the readout pops. 50/50: two
	// wrong choices sink away with a stagger. One use of each per session.
	byId('quiz-add-time').addEventListener('click', function () {
		if (!state.lifelines.addTime || state.locked) return;
		state.lifelines.addTime = false;
		state.timerDuration += 30000;
		state.endsAt += 30000;
		var bar = byId('quiz-timer-bar');
		bar.classList.add('bonus');
		var timer = byId('quiz-timer');
		var float = document.createElement('span');
		float.className = 'quiz-bonus-float';
		float.textContent = '+30s';
		timer.appendChild(float);
		var text = byId('quiz-timer-text');
		text.classList.add('quiz-timer-pop');
		setTimeout(function () {
			if (float.parentNode) float.parentNode.removeChild(float);
			bar.classList.remove('bonus');
			text.classList.remove('quiz-timer-pop');
		}, 1100);
		updateLifelines();
	});

	byId('quiz-fifty-fifty').addEventListener('click', function () {
		if (!state.lifelines.fiftyFifty || state.locked) return;
		var q = currentQuestion();
		var wrong = shuffleArr([0, 1, 2, 3].filter(function (i) { return i !== q.answer; }));
		var targets = wrong.slice(0, 2);
		targets.forEach(function (choiceIndex, k) {
			var btn = byId('quiz-options').querySelector('[data-index="' + choiceIndex + '"]');
			if (!btn) return;
			setTimeout(function () { btn.classList.add('eliminating'); }, k * 140);
			setTimeout(function () {
				btn.classList.remove('eliminating');
				btn.disabled = true;
				btn.classList.add('eliminated');
			}, 300 + k * 140);
		});
		state.lifelines.fiftyFifty = false;
		updateLifelines();
	});

	byId('quiz-next').addEventListener('click', advance);

	byId('quiz-again-btn').addEventListener('click', function () {
		startQuiz();
	});

	byId('quiz-clear-history').addEventListener('click', function () {
		var modal = byId('quiz-clear-modal');
		if (modal && window.$) { window.$(modal).modal('show'); }
		else if (window.confirm &&
			window.confirm('Clear your quiz history from this device?')) {
			clearHistory();
		}
	});

	window.AayatunQuiz = { clearHistory: clearHistory };

	renderStats();
})();
