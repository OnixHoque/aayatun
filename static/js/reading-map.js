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

	// Per-ayah theme tags (db/ayah_themes.db, inlined by the index route).
	// The map popup is the only surface that shows them; the share card
	// deliberately keeps its reading-only colours.
	var themeData = window.AAYATUN_THEMES || {};
	var themes = Array.isArray(themeData.themes) ? themeData.themes : [];
	var themeVerse = Array.isArray(themeData.verses) ? themeData.verses : [];
	var hasThemes = themes.length === 12 && themeVerse.length === VERSE_COUNT;
	var themesOn = false;

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
	// First verse of each surah, so the map can leave a blank square there.
	var starts = {};
	for (var k = 0; k < surahStart.length; k++) starts[surahStart[k]] = 1;

	// A blank square is inserted before each surah, so a verse's cell index is
	// its own index plus every break at or before it.
	var breakBefore = new Uint16Array(VERSE_COUNT);
	(function () {
		var running = 0;
		for (var b = 0; b < VERSE_COUNT; b++) {
			if (b && starts[b]) running++;
			breakBefore[b] = running;
		}
	})();

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
	var axis = document.getElementById('reading-map-axis');
	var xBar = document.getElementById('reading-map-x');
	var xThumb = xBar ? xBar.querySelector('.reading-map-scrollbar-thumb') : null;
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
	var themeToggle = document.getElementById('reading-map-themes');
	var themeLegend = document.getElementById('reading-map-theme-legend');
	var themeAttribution = document.getElementById('reading-map-theme-attribution');

	if (!grid || !globe || surahs.length !== 114) return;

	initThemes();

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

	// 0 not yet, 1 seen on a visited page, 2/3/4 opened 1x/2x/3+x. The share
	// card draws from the same numbers, so both views shade identically.
	function stateOf(m, i)
	{
		if (!m) return 0;
		var level = m.level[i];
		if (level) return level + 1;
		if (hasPageMap && hasBit(m.p, pageOf[i])) return 1;
		return 0;
	}

	var STATE_CLASS = ['', 'light', 'deep-1', 'deep-2', 'deep-3'];

	// Column-major order, like GitHub's contribution grid: each column holds
	// the verses for one column of rows, so scrolling right walks the mushaf
	// forward and every row stays visible at once. A blank square before each
	// surah keeps the blocks apart, the way the row-major grid did.
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
			cell.className = 'rg-cell' + (hasThemes ? ' t' + themeVerse[i] : '');
			cell.setAttribute('data-i', i);
			if (hasThemes) {
				var dot = document.createElement('i');
				dot.className = 'rg-dot';
				dot.setAttribute('aria-hidden', 'true');
				cell.appendChild(dot);
			}
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
			if (state > 1) deep++;
			cell.className = 'rg-cell' +
				(hasThemes ? ' t' + themeVerse[i] : '') +
				(state ? ' is-' + STATE_CLASS[state] : '') +
				(i === selected ? ' is-selected' : '');
		}

		var pages = 0;
		if (currentMap && hasPageMap) {
			for (var b = 0; b < PAGE_COUNT; b++) {
				if (hasBit(currentMap.p, b)) pages++;
			}
		}

		grid.setAttribute('aria-label', 'Quran Exploration Map: ' + deep +
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

	// Theme dots and legend (popup only). The toggle is remembered so the
	// map opens the way the reader left it; the share card stays reading-only.
	function renderThemeLegend()
	{
		if (!themeLegend || !hasThemes) return;
		themeLegend.textContent = '';
		for (var t = 0; t < themes.length; t++) {
			var item = document.createElement('span');
			item.className = 'rg-theme-key';
			var swatch = document.createElement('i');
			swatch.className = 'rg-dot';
			swatch.style.background = themes[t].color || '';
			swatch.setAttribute('aria-hidden', 'true');
			var label = document.createElement('span');
			label.textContent = themes[t].name;
			var count = 0;
			for (var i = 0; i < themeVerse.length; i++) {
				if (themeVerse[i] === t) count++;
			}
			var num = document.createElement('b');
			num.textContent = ' ' + count.toLocaleString();
			item.appendChild(swatch);
			item.appendChild(label);
			item.appendChild(num);
			themeLegend.appendChild(item);
		}
	}

	function setThemes(on)
	{
		themesOn = !!on;
		if (grid) grid.classList.toggle('themes-on', themesOn);
		if (themeToggle) {
			themeToggle.setAttribute('aria-pressed', themesOn ? 'true' : 'false');
			themeToggle.classList.toggle('is-on', themesOn);
		}
		if (themeLegend) themeLegend.hidden = !themesOn;
		if (themeAttribution) themeAttribution.hidden = !themesOn;
		try {
			localStorage.setItem('aayatun_read_map_themes_v1', themesOn ? '1' : '0');
		} catch (e) {}
	}

	function initThemes()
	{
		if (!hasThemes) {
			if (themeToggle) themeToggle.hidden = true;
			if (themeLegend) themeLegend.hidden = true;
			if (themeAttribution) themeAttribution.hidden = true;
			return;
		}
		renderThemeLegend();
		var saved = null;
		try { saved = localStorage.getItem('aayatun_read_map_themes_v1'); } catch (e) {}
		setThemes(saved === '1');
		if (themeToggle) {
			themeToggle.hidden = false;
			themeToggle.addEventListener('click', function () {
				setThemes(!themesOn);
			});
		}
	}

	// One way only: the map takes whatever height is left in the viewport,
	// and the resulting number of rows fixes how many columns 6,236 verses
	// need. The columns then run off to the right and only the width scrolls.
	var PITCH = 13;       // 10 px cell + 3 px gap
	var mapRows = 0;

	function layoutMap()
	{
		if (!grid || !scroll) return;
		var top = scroll.getBoundingClientRect().top;
		// Leave room for the page ticks, the legend inside the frame and the
		// scrollbar under it, so the whole map block fits without scrolling.
		var avail = window.innerHeight - top - 76;
		avail = Math.max(126,
			Math.min(avail, Math.round(window.innerHeight * 0.7)));
		var rows = Math.max(12, Math.floor((avail + 3) / PITCH));
		if (rows !== mapRows) {
			mapRows = rows;
			grid.style.setProperty('--map-rows', String(rows));
			scroll.style.height = (rows * PITCH + 26) + 'px';
		}
		renderAxis();
	}

	// Sparse page ticks over the columns: one label where each 50th printed
	// page begins, plus the first, dropped when it would crowd the previous
	// one. They live in the scroller, so they pan with the verses.
	function renderAxis()
	{
		if (!axis || !mapRows || !hasPageMap || !built) return;
		var cells = grid.childElementCount;
		if (!cells) return;
		var width = Math.ceil(cells / mapRows) * PITCH - 3;
		axis.style.width = width + 'px';

		while (axis.firstChild) axis.removeChild(axis.firstChild);
		var lastX = -1000;
		var last = null;
		for (var page = 0; page < PAGE_COUNT; page++) {
			var no = page + 1;
			if (no !== 1 && no % 50 !== 0) continue;
			var verse = bounds[page];
			if (!(verse >= 0) || verse >= VERSE_COUNT) continue;
			var x = Math.floor((verse + breakBefore[verse]) / mapRows) * PITCH;
			if (x - lastX < 90) continue;
			var tick = document.createElement('span');
			tick.style.left = x + 'px';
			tick.textContent = 'Page ' + no;
			axis.appendChild(tick);
			// The final label may not fit inside the strip; pull it back so it
			// stays whole instead of being clipped by the edge.
			var over = x + tick.offsetWidth - width;
			if (over > 0 && x - over - lastX >= 90) {
				tick.style.left = (x - over) + 'px';
			}
			lastX = tick.offsetLeft;
			last = tick;
		}
		if (last && last.offsetLeft + last.offsetWidth > width) {
			axis.removeChild(last);
		}
	}

	// The scrollbar mirrors the map position and is its only visible scroll
	// affordance: the native one is hidden because phones never show it.
	function syncX()
	{
		if (!scroll || !xBar || !xThumb) return;
		var max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
		if (max <= 1) {
			xBar.hidden = true;
			return;
		}
		xBar.hidden = false;
		var track = xBar.clientWidth;
		var w = Math.max(40,
			Math.round(track * scroll.clientWidth / scroll.scrollWidth));
		xThumb.style.width = w + 'px';
		xThumb.style.transform = 'translateX(' +
			Math.round(Math.max(1, track - w) * (scroll.scrollLeft / max)) + 'px)';
		xBar.setAttribute('aria-valuenow',
			String(Math.round((scroll.scrollLeft / max) * 100)));
	}

	// The map always opens at its start (Al-Fatihah at the top left), so the
	// scrollbar thumb begins at the left edge and the map reads forwards.

	if (xBar && xThumb && scroll) {
		// Drag the thumb, or click the track to jump there.
		var dragging = false;
		var dragX = 0;
		var dragLeft = 0;

		function barJump(evt)
		{
			var rect = xBar.getBoundingClientRect();
			var span = Math.max(1, rect.width - xThumb.offsetWidth);
			var max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
			scroll.scrollLeft = Math.max(0, Math.min(max,
				(evt.clientX - rect.left - xThumb.offsetWidth / 2) / span * max));
			syncX();
		}

		xBar.addEventListener('pointerdown', function (evt) {
			if (evt.button !== undefined && evt.button !== 0) return;
			if (evt.target !== xThumb) {
				barJump(evt);
				return;
			}
			dragging = true;
			dragX = evt.clientX;
			dragLeft = scroll.scrollLeft;
			xBar.setPointerCapture(evt.pointerId);
			evt.preventDefault();
		});

		xBar.addEventListener('pointermove', function (evt) {
			if (!dragging) return;
			var span = Math.max(1, xBar.clientWidth - xThumb.offsetWidth);
			var max = scroll.scrollWidth - scroll.clientWidth;
			scroll.scrollLeft = dragLeft + (evt.clientX - dragX) * (max / span);
		});

		function endDrag(evt)
		{
			dragging = false;
			if (xBar.hasPointerCapture && xBar.hasPointerCapture(evt.pointerId)) {
				xBar.releasePointerCapture(evt.pointerId);
			}
		}
		xBar.addEventListener('pointerup', endDrag);
		xBar.addEventListener('pointercancel', endDrag);

		xBar.addEventListener('keydown', function (evt) {
			var max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
			var step = Math.max(80, scroll.clientWidth * 0.8);
			if (evt.key === 'ArrowRight') scroll.scrollLeft += step;
			else if (evt.key === 'ArrowLeft') scroll.scrollLeft -= step;
			else if (evt.key === 'Home') scroll.scrollLeft = 0;
			else if (evt.key === 'End') scroll.scrollLeft = max;
			else return;
			evt.preventDefault();
		});

		scroll.addEventListener('scroll', syncX, { passive: true });
		window.addEventListener('resize', function () {
			layoutMap();
			syncX();
		});
	}

	// Walk forward from the last read verse (wrapping), preferring the first
	// white verse; when every verse is coloured, fall back to page-only, then
	// to any opened verse.
	function suggest(m)
	{
		var start = m && m.last >= 0 ? m.last : -1;
		function nearest(match)
		{
			for (var n = 1; n <= VERSE_COUNT; n++) {
				var i = (start + n) % VERSE_COUNT;
				if (match(stateOf(m, i))) return i;
			}
			return -1;
		}

		var idx = nearest(function (st) { return st === 0; });
		var kind = 'none';
		if (idx < 0) {
			idx = nearest(function (st) { return st === 1; });
			kind = 'light';
		}
		if (idx < 0) {
			idx = nearest(function (st) { return st > 1; });
			kind = 'deep';
		}

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
			(state === 0 ? ' — not yet'
				: state === 1 ? ' — seen on page'
				: state === 2 ? ' — opened once'
				: state === 3 ? ' — opened twice'
				: ' — opened 3+ times');
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

	// Clicking anywhere outside the map itself (the readout cards, the
	// legend, the page or the dimmer) drops the selection, so the readout
	// returns to its hint and no square stays highlighted.
	document.addEventListener('click', function (evt) {
		if (selected < 0 || grid.contains(evt.target)) return;
		selected = -1;
		var prev = grid.querySelector('.rg-cell.is-selected');
		if (prev) prev.classList.remove('is-selected');
		renderReadout(-1);
	});

	// 0 = not yet, 1 = seen on a visited page, 2..4 = verse opened 1x/2x/3+x.
	// The share card draws from this array so it never re-derives the bitsets.
	// stateHash signs the positions too, so the cached share card is thrown
	// away when a different verse is read rather than only when a count moves.
	var stateHash = 0;

	function mapStates()
	{
		var out = new Uint8Array(VERSE_COUNT);
		var hash = 0;
		for (var i = 0; i < VERSE_COUNT; i++) {
			var state = stateOf(currentMap, i);
			out[i] = state;
			hash = (hash * 31 + state * (i + 1)) | 0;
		}
		stateHash = hash;
		return out;
	}

	function shareData()
	{
		return {
			deep: stats.deep, pages: stats.pages,
			states: mapStates(), hash: stateHash, starts: surahStart
		};
	}

	// Draw and encode the share card off the tap path: the tap itself only
	// has to open the share sheet.
	function warmShare()
	{
		if (window.AayatunShare && window.AayatunShare.warmMapShare) {
			window.AayatunShare.warmMapShare(shareData());
		}
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
		window.setTimeout(warmShare, 400);
	}

	window.AayatunReadingMap = {
		states: mapStates,
		shareData: shareData,
		share: shareMap,
		refresh: refresh
	};

	globe.addEventListener('click', function (evt) {
		evt.preventDefault();
		var nav = window.AayatunNav;
		// Building all 6,236 cells blocks the main thread, so the first open
		// shows the site's loading bar. Let it paint before the build starts.
		var firstOpen = !built;
		if (firstOpen) {
			if (nav && nav.loading) nav.loading();
			else if (window.showLoading) window.showLoading();
		}

		function done() {
			if (nav && nav.done) nav.done();
			else if (window.hideLoading) window.hideLoading();
		}

		window.requestAnimationFrame(function () {
			window.setTimeout(function () {
				if (!built) build();
				paint();
				if (window.jQuery) {
					window.jQuery('#reading-map-modal').modal('show');
					window.requestAnimationFrame(function () {
						window.requestAnimationFrame(function () {
							layoutMap();
							scroll.scrollLeft = 0;
							syncX();
							if (firstOpen) done();
						});
					});
					// The open animation moves (and scales) the modal, so the row
					// count is measured again once it has settled.
					window.setTimeout(function () {
						layoutMap();
						syncX();
					}, 400);
					// Let the modal finish opening before the card is drawn.
					window.setTimeout(warmShare, 450);
				} else if (firstOpen) {
					done();
				}
			}, 0);
		});
	});
})();
