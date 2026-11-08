/*
 * Reading map: a GitHub-contribution-style grid of all 6,236 verses.
 *
 * One square per verse in canonical mushaf order. The map data comes from
 * recent.js (localStorage bitsets), so it needs no network: a verse is deep
 * green when its detail page has been opened, light green when it sits on a
 * printed mushaf page that was opened, and white otherwise. Deep always wins.
 *
 * The verse -> page mapping is a 604-entry start-offset array rendered by the
 * index route (window.AAYATUN_PAGE_BOUNDS); page membership in db/qcf_verses
 * .json is contiguous, so the client can fill it in a single pass. Surah names
 * and verse counts come from the picker options already in the page.
 */
(function () {
	var VERSE_COUNT = 6236;
	var PAGE_COUNT = 604;

	var bounds = Array.isArray(window.AAYATUN_PAGE_BOUNDS)
		? window.AAYATUN_PAGE_BOUNDS : [];
	var hasPageMap = bounds.length === PAGE_COUNT;

	// Capture the surah table before the dropdown plugin touches the select.
	var surahs = [];
	var options = document.querySelectorAll('#surah option');
	for (var o = 0; o < options.length; o++) {
		// The picker reads "2. Al-Baqarah (the Cow)"; labels want the same
		// short name the share cards use.
		var name = (options[o].textContent || '').trim()
			.replace(/^\d+\.\s*/, '')
			.replace(/\s*\([^)]*\)\s*$/, '');
		surahs.push({
			no: parseInt(options[o].value, 10),
			name: name,
			count: parseInt(options[o].getAttribute('verse_count'), 10) || 0
		});
	}
	var surahStart = [];
	var total = 0;
	for (var s = 0; s < surahs.length; s++) {
		surahStart.push(total);
		total += surahs[s].count;
	}
	var starts = {};
	for (var k = 0; k < surahStart.length; k++) starts[surahStart[k]] = 1;

	// verse index -> 0-based page
	var pageOf = new Uint16Array(VERSE_COUNT);
	if (hasPageMap) {
		for (var p = 0; p < PAGE_COUNT; p++) {
			var end = p + 1 < PAGE_COUNT ? bounds[p + 1] : VERSE_COUNT;
			for (var i = bounds[p]; i < end && i < VERSE_COUNT; i++) pageOf[i] = p;
		}
	}

	var grid = document.getElementById('reading-map-grid');
	var scroll = document.getElementById('reading-map-scroll');
	var summary = document.getElementById('reading-map-summary');
	var hint = document.getElementById('reading-map-hint');
	var openLink = document.getElementById('reading-map-open');
	var nextBox = document.getElementById('reading-map-next');
	var globe = document.getElementById('recent-map');

	if (!grid || !globe || surahs.length !== 114) return;

	var built = false;
	var currentMap = null;

	function hasBit(bits, i)
	{
		return i >= 0 && i < bits.length * 8 &&
			(bits[i >> 3] & (1 << (i & 7))) !== 0;
	}

	// Binary search: index -> { surah, verse }.
	function locate(i)
	{
		var lo = 0;
		var hi = surahs.length - 1;
		while (lo < hi) {
			var mid = (lo + hi + 1) >> 1;
			if (surahStart[mid] <= i) lo = mid;
			else hi = mid - 1;
		}
		return { s: surahs[lo], verse: i - surahStart[lo] + 1 };
	}

	function stateOf(m, i)
	{
		if (!m) return 'none';
		if (hasBit(m.v, i)) return 'deep';
		if (hasPageMap && hasBit(m.p, pageOf[i])) return 'light';
		return 'none';
	}

	function build()
	{
		var frag = document.createDocumentFragment();
		for (var i = 0; i < VERSE_COUNT; i++) {
			if (i && starts[i]) {
				var brk = document.createElement('span');
				brk.className = 'rg-break';
				frag.appendChild(brk);
			}
			var cell = document.createElement('span');
			cell.className = 'rg-cell';
			cell.setAttribute('data-i', i);
			frag.appendChild(cell);
		}
		grid.appendChild(frag);
		built = true;
	}

	function paint()
	{
		currentMap = (window.AayatunRecent && window.AayatunRecent.map)
			? window.AayatunRecent.map() : null;
		var deep = 0;
		var children = grid.children;
		for (var n = 0; n < children.length; n++) {
			var cell = children[n];
			var raw = cell.getAttribute('data-i');
			if (raw === null) continue;
			var i = +raw;
			var state = stateOf(currentMap, i);
			if (state === 'deep') deep++;
			cell.className = 'rg-cell' +
				(state === 'deep' ? ' is-deep' : state === 'light' ? ' is-light' : '') +
				(currentMap && currentMap.last === i ? ' is-last' : '');
		}

		var pages = 0;
		if (currentMap && hasPageMap) {
			for (var b = 0; b < PAGE_COUNT; b++) {
				if (hasBit(currentMap.p, b)) pages++;
			}
		}

		summary.textContent = deep.toLocaleString() + ' of 6,236 verses studied · ' +
			pages + ' of 604 pages visited';
		grid.setAttribute('aria-label', 'Reading map: ' + deep +
			' of 6,236 verses studied, ' + pages + ' of 604 pages visited.');

		suggest(currentMap);
	}

	// The grid has no layout while the modal is hidden, so centre the last
	// read verse only after the modal is visible.
	function scrollToLast()
	{
		if (!currentMap || currentMap.last < 0 || !scroll) return;
		var last = grid.querySelector('[data-i="' + currentMap.last + '"]');
		if (last) {
			scroll.scrollTop = Math.max(0,
				last.offsetTop - scroll.clientHeight / 2 + last.offsetHeight / 2);
		}
	}

	// Walk forward from the last read verse (wrapping), preferring the first
	// white verse; when every verse is coloured, fall back to light, then deep.
	function suggest(m)
	{
		var start = m && m.last >= 0 ? m.last : -1;
		function nearest(state)
		{
			for (var n = 1; n <= VERSE_COUNT; n++) {
				var i = (start + n) % VERSE_COUNT;
				if (stateOf(m, i) === state) return i;
			}
			return -1;
		}

		var idx = nearest('none');
		var kind = 'none';
		if (idx < 0) { idx = nearest('light'); kind = 'light'; }
		if (idx < 0) { idx = nearest('deep'); kind = 'deep'; }

		nextBox.textContent = '';
		if (idx < 0) return;

		var loc = locate(idx);
		var label = loc.s.name + ' ' + loc.s.no + ':' + loc.verse;
		var prefix = kind === 'none' ? 'Next unread: '
			: kind === 'light' ? 'Next to study: ' : 'All verses opened — revisit ';
		var a = document.createElement('a');
		a.href = '/' + loc.s.no + '/' + loc.verse;
		a.textContent = label;
		nextBox.appendChild(document.createTextNode(prefix));
		nextBox.appendChild(a);
		if (kind === 'light') {
			nextBox.appendChild(document.createTextNode(' (seen on a visited page)'));
		}
	}

	function showCell(i)
	{
		if (!openLink || !hint) return;
		var loc = locate(i);
		var state = stateOf(currentMap, i);
		openLink.textContent = loc.s.name + ' ' + loc.s.no + ':' + loc.verse +
			(state === 'deep' ? ' — studied'
				: state === 'light' ? ' — seen on page' : ' — not yet');
		openLink.href = '/' + loc.s.no + '/' + loc.verse;
		openLink.hidden = false;
		hint.hidden = true;
	}

	function onCell(evt)
	{
		var node = evt.target;
		while (node && node !== grid && !(node.getAttribute && node.getAttribute('data-i'))) {
			node = node.parentNode;
		}
		if (node && node !== grid) showCell(+node.getAttribute('data-i'));
	}

	grid.addEventListener('pointerover', onCell);
	grid.addEventListener('click', onCell);

	globe.addEventListener('click', function (evt) {
		evt.preventDefault();
		if (!built) build();
		paint();
		if (window.jQuery) {
			window.jQuery('#reading-map-modal').modal('show');
			window.requestAnimationFrame(function () {
				window.requestAnimationFrame(scrollToLast);
			});
		}
	});
})();
