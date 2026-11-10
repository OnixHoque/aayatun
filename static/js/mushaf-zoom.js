/*
 * Zoom for the mushaf reading views (/page/<n> and /mushaf/<surah>).
 *
 * Four steps (100, 125, 150, 175 %) scale the Arabic text through the
 * --mushaf-zoom custom property, which static/css/style.css multiplies into
 * .mushaf-ayah, so both the plain Scheherazade text and the QCF glyph face
 * grow together. The printed line layout on /page/<n> fits its lines in px,
 * so it refits itself on every change through onChange(); above 100 % a
 * printed line wraps inside the column instead of running off the screen.
 *
 * The step is remembered in localStorage['aayatun_mushaf_zoom_v1'] and the
 * key is shared by both views: a reader who zooms one page keeps that size
 * when they move to the other view.
 */
(function () {
	var KEY = 'aayatun_mushaf_zoom_v1';
	var LEVELS = [100, 125, 150, 175];
	var index = 0;
	var listeners = [];

	try {
		var stored = parseInt(localStorage.getItem(KEY), 10);
		if (stored >= 0 && stored < LEVELS.length) index = stored;
	} catch (e) {}

	function percent()
	{
		return LEVELS[index];
	}

	function factor()
	{
		return LEVELS[index] / 100;
	}

	function paint()
	{
		document.documentElement.style.setProperty('--mushaf-zoom', String(factor()));

		var out = document.getElementById('zoom-level');
		if (out) {
			out.textContent = percent() + '%';
			out.setAttribute('title', 'Zoom level: ' + percent() + '%');
		}
		var minus = document.getElementById('zoom-out-btn');
		var plus = document.getElementById('zoom-in-btn');
		if (minus) minus.disabled = index === 0;
		if (plus) plus.disabled = index === LEVELS.length - 1;

		for (var i = 0; i < listeners.length; i++) {
			try { listeners[i](percent()); } catch (e) {}
		}
	}

	function step(delta)
	{
		var next = index + delta;
		if (next < 0 || next >= LEVELS.length) return;
		index = next;
		try { localStorage.setItem(KEY, String(index)); } catch (e) {}
		paint();
	}

	function onChange(fn)
	{
		if (typeof fn === 'function') listeners.push(fn);
	}

	// The level is painted before the first frame (the script is deferred),
	// so the page never flashes at 100% and then jumps to the stored size.
	window.MushafZoom = {
		factor: factor,
		percent: percent,
		step: step,
		onChange: onChange
	};

	paint();

	function wire()
	{
		var minus = document.getElementById('zoom-out-btn');
		var plus = document.getElementById('zoom-in-btn');
		if (minus) minus.addEventListener('click', function () { step(-1); });
		if (plus) plus.addEventListener('click', function () { step(1); });
		paint();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wire);
	} else {
		wire();
	}
})();
