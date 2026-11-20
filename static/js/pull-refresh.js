/*
 * Pull-to-refresh for the whole site.
 *
 * At the very top of the page, a downward single-finger drag shows a small
 * circular spinner that follows the finger; releasing past the threshold
 * reloads the page. Android Chrome already has this gesture natively — this
 * makes iOS Safari and installed PWAs behave the same.
 *
 * Pages opt out with `data-no-ptr` on <html> (used by /quiz, where an
 * accidental reload would lose the round).
 *
 * Only vertical-dominant downward gestures are claimed; horizontal swipes
 * (verse carousel, mushaf page turns, map pan) are left alone.
 */
(function () {
	'use strict';

	var html = document.documentElement;

	// Opt-out for the quiz page (and any page that sets data-no-ptr).
	if (html.hasAttribute('data-no-ptr') || html.getAttribute('data-no-ptr') === 'true') return;

	// One small injected style block — keeps base.html's diff to a single
	// <script defer> line. (No overscroll-behavior: it would kill the
	// iOS rubber-band bounce the reader wants.)
	var css = document.createElement('style');
	css.textContent = [
		'#ptr-spinner{position:fixed;top:calc(10px + env(safe-area-inset-top, 0px));left:50%;',
		'width:34px;height:34px;margin-left:-17px;border-radius:50%;opacity:0;z-index:4000;',
		'background:rgba(255,255,255,.92);box-shadow:0 1px 3px rgba(0,0,0,.18),0 0 0 1px rgba(34,36,38,.08);',
		'display:flex;align-items:center;justify-content:center;pointer-events:none;',
		'will-change:transform,opacity;}',
		'html.dark-theme #ptr-spinner{background:rgba(38,40,43,.95);',
		'box-shadow:0 1px 3px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.09);}',
		'#ptr-spinner svg{width:20px;height:20px;stroke:#3c3f42;stroke-width:2.4;',
		'fill:none;stroke-linecap:round;stroke-linejoin:round;}',
		'html.dark-theme #ptr-spinner svg{stroke:rgba(255,255,255,.85);}',
		'#ptr-spinner.is-ready svg{stroke:#2185d0;}',
		'#ptr-spinner.is-loading{opacity:1 !important;}',
		'#ptr-spinner.is-loading svg{animation:ptr-rotate .7s linear infinite;}',
		'@media (prefers-reduced-motion: reduce){#ptr-spinner.is-loading svg{animation:none;}}',
		'@keyframes ptr-rotate{from{transform:rotate(0deg);}to{transform:rotate(-360deg);}}'
	].join('\n');
	(document.head || document.documentElement).appendChild(css);

	var PULL_MAX = 110;      // px the spinner may travel, after damping
	var READY = 58;          // px damped pull at which release reloads
	var MIN_VISIBLE = 14;    // px before the spinner is shown at all
	var TOP_EPS = 1;         // scroll positions at or below this count as "at the top"

	// The offset that means "how far is the page scrolled" — but WHICH
	// element scrolls differs by engine. Fomantic ships body,html{height:100%}
	// and body{overflow-x:hidden} (which computes to overflow:hidden auto), so
	// some engines — iOS WebKit in particular — scroll the BODY instead of the
	// viewport. window.scrollY then stays 0 forever and this gate would always
	// claim the gesture. Read every scroller and take the maximum; iOS reports
	// negative offsets during the rubber-band bounce, which Math.max keeps as
	// "at the top".
	function scrollPos() {
		var doc = document.documentElement;
		var body = document.body;
		var y = Math.max(
			window.scrollY || 0,
			window.pageYOffset || 0,
			doc && doc.scrollTop ? doc.scrollTop : 0,
			body && body.scrollTop ? body.scrollTop : 0
		);
		return y < 0 ? 0 : y;
	}

	var spinner = null;
	var armed = false;
	var startY = 0, startX = 0, dy = 0;

	function getSpinner() {
		if (spinner) return spinner;
		spinner = document.createElement('div');
		spinner.id = 'ptr-spinner';
		spinner.setAttribute('aria-hidden', 'true');
		spinner.innerHTML =
			'<svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
		document.body.appendChild(spinner);
		return spinner;
	}

	function reset() {
		dy = 0;
		armed = false;
		if (!spinner) return;
		var s = spinner.style;
		s.transition = 'transform .22s ease, opacity .22s ease';
		s.opacity = '0';
		s.transform = 'translateY(' + (-60) + 'px)';
		spinner.classList.remove('is-ready', 'is-loading');
	}

	function onStart(e) {
		// Only single-finger touches at the very top of the page.
		if (e.touches.length !== 1) { armed = false; return; }
		if (scrollPos() > TOP_EPS) { armed = false; return; }
		armed = true;
		startY = e.touches[0].clientY;
		startX = e.touches[0].clientX;
		dy = 0;
	}

	function onMove(e) {
		if (!armed || e.touches.length !== 1) return;
		if (scrollPos() > TOP_EPS) { reset(); return; }
		var t = e.touches[0];
		var moveY = t.clientY - startY;
		var moveX = t.clientX - startX;
		// Only claim clearly vertical, downward drags.
		if (moveY <= 0 || Math.abs(moveY) < Math.abs(moveX) * 1.4) {
			if (Math.abs(moveY) > Math.abs(moveX) * 1.4 || moveY <= 0) reset();
			return;
		}
		e.preventDefault();
		var pulled = Math.min(moveY * 0.55, PULL_MAX);
		dy = pulled;
		var s = getSpinner();
		s.style.transition = 'none';
		s.style.opacity = String(Math.min(1, pulled / MIN_VISIBLE));
		s.style.transform = 'translateY(' + pulled + 'px)';
		s.classList.toggle('is-ready', pulled >= READY);
	}

	function onEnd() {
		if (!armed) return;
		// Enough pull? Reload — the site's loading bar shows via onbeforeunload.
		if (dy >= READY) {
			var s = getSpinner();
			s.classList.add('is-loading');
			s.classList.remove('is-ready');
			armed = false;
			window.location.reload();
			return;
		}
		reset();
	}

	document.addEventListener('touchstart', onStart, { passive: true });
	document.addEventListener('touchmove', onMove, { passive: false });
	document.addEventListener('touchend', onEnd, { passive: true });
	document.addEventListener('touchcancel', onEnd, { passive: true });
})();
