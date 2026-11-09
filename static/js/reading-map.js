/*
 * Quran exploration map: a GitHub-contribution-style grid of all 6,236 verses.
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
	var hint = document.getElementById('reading-map-hint');
	var openLink = document.getElementById('reading-map-open');
	var nextBox = document.getElementById('reading-map-next');
	var globe = document.getElementById('recent-map');
	var shareBtn = document.getElementById('reading-map-share');
	var pagesRing = document.getElementById('reading-map-pages-ring');
	var pagesPctEl = document.getElementById('reading-map-pages-pct');
	var pagesNote = document.getElementById('reading-map-pages-note');
	var versesRing = document.getElementById('reading-map-verses-ring');
	var versesPctEl = document.getElementById('reading-map-verses-pct');
	var versesNote = document.getElementById('reading-map-verses-note');

	if (!grid || !globe || surahs.length !== 114) return;

	var built = false;
	var currentMap = null;
	// Clicking a square selects it: the readout and border stay on that verse
	// until another square is clicked. Hovering only previews its label.
	var selected = -1;

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

	var stats = { deep: 0, pages: 0 };

	function percent(n, total)
	{
		return total ? (n / total) * 100 : 0;
	}

	function pctLabel(p)
	{
		if (!p) return '0%';
		if (p >= 99.95) return '100%';
		if (p < 1) return p.toFixed(2) + '%';
		if (p < 10) return p.toFixed(1) + '%';
		return Math.round(p) + '%';
	}

	// The rings use r=20 (viewBox 48), so the dash length is the circumference.
	var RING_C = 2 * Math.PI * 20;

	function setRing(el, pct)
	{
		if (!el) return;
		var p = Math.min(100, Math.max(0, pct));
		el.style.strokeDashoffset = (RING_C * (1 - p / 100)).toFixed(2);
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
				(i === selected ? ' is-selected' : '');
		}

		var pages = 0;
		if (currentMap && hasPageMap) {
			for (var b = 0; b < PAGE_COUNT; b++) {
				if (hasBit(currentMap.p, b)) pages++;
			}
		}

		grid.setAttribute('aria-label', 'Quran exploration map: ' + deep +
			' of 6,236 verses studied, ' + pages + ' of 604 pages visited.');
		stats.deep = deep;
		stats.pages = pages;

		var pagesPct = percent(pages, PAGE_COUNT);
		var versesPct = percent(deep, VERSE_COUNT);
		setRing(pagesRing, pagesPct);
		setRing(versesRing, versesPct);
		if (pagesPctEl) pagesPctEl.textContent = pctLabel(pagesPct);
		if (versesPctEl) versesPctEl.textContent = pctLabel(versesPct);
		if (pagesNote) pagesNote.textContent = pages + ' of 604';
		if (versesNote) versesNote.textContent = deep.toLocaleString() + ' of 6,236';
		if (pagesRing && pagesRing.ownerSVGElement)
			pagesRing.ownerSVGElement.setAttribute('aria-valuenow', pages);
		if (versesRing && versesRing.ownerSVGElement)
			versesRing.ownerSVGElement.setAttribute('aria-valuenow', deep);

		suggest(currentMap);
		renderReadout(selected);
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
		var prefix = kind === 'none' ? 'Suggested next unread: '
			: kind === 'light' ? 'Suggested next to study: ' : 'All verses opened — revisit ';
		var a = document.createElement('a');
		a.href = '/' + loc.s.no + '/' + loc.verse;
		a.textContent = label;
		nextBox.appendChild(document.createTextNode(prefix));
		nextBox.appendChild(a);
		if (kind === 'light') {
			nextBox.appendChild(document.createTextNode(' (seen on a visited page)'));
		}
	}

	function renderReadout(i)
	{
		if (!openLink || !hint) return;
		if (!(i >= 0) || i >= VERSE_COUNT) {
			openLink.hidden = true;
			hint.hidden = false;
			return;
		}
		var loc = locate(i);
		var state = stateOf(currentMap, i);
		openLink.textContent = loc.s.name + ' ' + loc.s.no + ':' + loc.verse +
			(state === 'deep' ? ' — studied'
				: state === 'light' ? ' — seen on page' : ' — not yet');
		openLink.href = '/' + loc.s.no + '/' + loc.verse;
		openLink.hidden = false;
		hint.hidden = true;
	}

	function cellOf(evt)
	{
		var node = evt.target;
		while (node && node !== grid && !(node.getAttribute && node.getAttribute('data-i'))) {
			node = node.parentNode;
		}
		return (node && node !== grid) ? node : null;
	}

	function hoverCell(evt)
	{
		// Touch has no hover: a tap goes straight to the click selection.
		if (evt.pointerType && evt.pointerType !== 'mouse') return;
		var node = cellOf(evt);
		renderReadout(node ? +node.getAttribute('data-i') : selected);
	}

	function selectCell(evt)
	{
		var node = cellOf(evt);
		if (!node) return;
		var i = +node.getAttribute('data-i');
		if (selected >= 0) {
			var prev = grid.querySelector('.rg-cell.is-selected');
			if (prev) prev.classList.remove('is-selected');
		}
		selected = i;
		node.classList.add('is-selected');
		renderReadout(i);
	}

	function leaveGrid(evt)
	{
		if (evt.pointerType && evt.pointerType !== 'mouse') return;
		renderReadout(selected);
	}

	grid.addEventListener('pointermove', hoverCell);
	grid.addEventListener('click', selectCell);
	grid.addEventListener('pointerleave', leaveGrid);

	// 0 = not yet, 1 = seen on a visited page, 2 = verse page opened. The
	// share card draws from this array so it never re-derives the bitsets.
	function mapStates()
	{
		var out = new Uint8Array(VERSE_COUNT);
		for (var i = 0; i < VERSE_COUNT; i++) {
			var state = stateOf(currentMap, i);
			out[i] = state === 'deep' ? 2 : state === 'light' ? 1 : 0;
		}
		return out;
	}

	function shareData()
	{
		return {
			deep: stats.deep, pages: stats.pages,
			states: mapStates(), starts: surahStart
		};
	}

	function shareMap()
	{
		if (window.AayatunShare && window.AayatunShare.shareMap) {
			window.AayatunShare.shareMap(shareData(), shareBtn);
		}
	}

	if (shareBtn) {
		shareBtn.addEventListener('click', function (evt) {
			evt.preventDefault();
			shareMap();
		});
	}

	function refresh()
	{
		selected = -1;
		paint();
	}

	window.AayatunReadingMap = {
		states: mapStates,
		shareData: shareData,
		share: shareMap,
		refresh: refresh
	};

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
