/*
 * Recently Read + the Quran exploration map.
 *
 * Recently Read is a small localStorage history of the reading views: one
 * entry per reading page (verse detail, mushaf page, full-arabic surah), at
 * most five, newest first. Runs of the same kind collapse to their newest
 * entry, so paging 42 -> 43 -> 44 leaves only "Page 44" in the list.
 *
 * Separately, every visit is folded into a bitset map for the exploration
 * graph: a deep bit per verse (its detail page was opened) and a light bit
 * per printed mushaf page. 6,236 + 604 bits is ~1.1 KB, so it is written on
 * every read without the list's five-entry cap losing detail. The map is
 * append-only; only the "clear history" confirmation removes it.
 *
 * Labels come from a server-rendered <meta name="aayatun-read"> in each
 * template ("type|key|label"), and the flat mushaf position from
 * <meta name="aayatun-read-index">, which avoids guessing from the title.
 * Inside the shared modal iframe the map still records the verse (it really
 * is open), but the chips keep the page behind the modal, as before.
 */
(function () {
	var KEY = 'aayatun_recent_reads_v1';
	var MAP_KEY = 'aayatun_read_map_v1';
	var MAX = 5;
	var TYPES = { verse: 1, page: 1, mushaf: 1 };

	// Canonical mushaf order: 0 = 1:1, 6235 = 114:6.
	var VERSE_BITS = 6236;
	var PAGE_BITS = 604;

	function valid(entry)
	{
		return !!entry && !!TYPES[entry.t] &&
			typeof entry.url === 'string' &&
			/^\/(?:page\/\d+|\d+\/\d+|mushaf\/\d+)$/.test(entry.url) &&
			typeof entry.label === 'string';
	}

	function list()
	{
		try {
			var stored = JSON.parse(localStorage.getItem(KEY) || '[]');
			return Array.isArray(stored) ? stored.filter(valid) : [];
		} catch (e) {
			return [];
		}
	}

	function write(items)
	{
		try {
			localStorage.setItem(KEY, JSON.stringify(items));
		} catch (e) {}
	}

	function currentEntry()
	{
		var el = document.querySelector('meta[name="aayatun-read"]');
		if (!el) return null;
		var parts = (el.getAttribute('content') || '').split('|');
		if (parts.length < 3 || !TYPES[parts[0]]) return null;
		return {
			t: parts[0],
			key: parts[1],
			url: window.location.pathname.replace(/\/+$/, '') || '/',
			label: parts.slice(2).join('|')
		};
	}

	function currentIndex()
	{
		var el = document.querySelector('meta[name="aayatun-read-index"]');
		if (!el) return -1;
		var i = parseInt(el.getAttribute('content'), 10);
		return (i >= 0 && i < VERSE_BITS) ? i : -1;
	}

	/* ------------------------------------------------------------ the map */

	function toB64(bytes)
	{
		var s = '';
		for (var i = 0; i < bytes.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		try { return btoa(s); } catch (e) { return ''; }
	}

	function fromB64(text, length)
	{
		var out = new Uint8Array(length);
		try {
			var raw = atob(text || '');
			var n = Math.min(raw.length, length);
			for (var i = 0; i < n; i++) out[i] = raw.charCodeAt(i);
		} catch (e) {}
		return out;
	}

	function blank()
	{
		return {
			v: new Uint8Array(Math.ceil(VERSE_BITS / 8)),
			p: new Uint8Array(Math.ceil(PAGE_BITS / 8)),
			last: -1
		};
	}

	function map()
	{
		var out = blank();
		try {
			var raw = JSON.parse(localStorage.getItem(MAP_KEY) || 'null');
			if (!raw || typeof raw !== 'object') return out;
			out.v = fromB64(raw.v, out.v.length);
			out.p = fromB64(raw.p, out.p.length);
			if (typeof raw.last === 'number' && raw.last >= 0 && raw.last < VERSE_BITS)
				out.last = raw.last;
		} catch (e) {}
		return out;
	}

	function save(m)
	{
		try {
			localStorage.setItem(MAP_KEY, JSON.stringify({
				v: toB64(m.v),
				p: toB64(m.p),
				last: m.last
			}));
		} catch (e) {}
	}

	function setBit(bits, i)
	{
		if (i >= 0 && i < bits.length * 8) bits[i >> 3] |= (1 << (i & 7));
	}

	function markVerse(index)
	{
		if (!(index >= 0) || index >= VERSE_BITS) return;
		var m = map();
		setBit(m.v, index);
		m.last = index;
		save(m);
	}

	function markPage(page, index)
	{
		var p = parseInt(page, 10);
		if (!(p >= 1) || p > PAGE_BITS) return;
		var m = map();
		setBit(m.p, p - 1);
		if (index >= 0 && index < VERSE_BITS) m.last = index;
		save(m);
	}

	// A swipe inside verse-nav.js never reloads the page, so the meta tags
	// still describe the verse we landed on. It emits aayatun:verse with the
	// current position and this maps it through the 114 surah offsets.
	function trackVerse(surah, verse, name)
	{
		var starts = window.AAYATUN_SURAH_STARTS;
		if (!Array.isArray(starts) || starts.length !== 114) return;
		surah = parseInt(surah, 10);
		verse = parseInt(verse, 10);
		if (!(surah >= 1 && surah <= 114) || !(verse >= 1)) return;
		var index = starts[surah - 1] + verse - 1;
		if (!(index >= 0) || index >= VERSE_BITS) return;
		markVerse(index);

		// The chips keep the page behind an open modal; swiping inside the
		// modal still colours the map.
		if (window.self !== window.top) return;

		var entry = {
			t: 'verse',
			key: surah + ':' + verse,
			url: '/' + surah + '/' + verse,
			label: surah + ':' + verse + (name ? ' · ' + name : '')
		};
		// The new position replaces the verse entry that opened the page.
		var items = list().filter(function (it) { return it.url !== entry.url; });
		if (items.length && items[0].t === 'verse') items.shift();
		entry.ts = Date.now();
		items.unshift(entry);
		write(items.slice(0, MAX));
	}

	/* ----------------------------------------------------------- recording */

	function record()
	{
		var entry = currentEntry();
		if (!entry) return;
		var index = currentIndex();

		if (entry.t === 'verse') markVerse(index);
		else if (entry.t === 'page') markPage(entry.key, index);

		// Verses opened in the shared modal count on the map, but they must
		// not replace what the reader was reading on the page behind it.
		if (window.self !== window.top) return;

		// Re-reading an entry moves it to the front instead of duplicating it.
		var items = list().filter(function (it) { return it.url !== entry.url; });
		// Consecutive reads of the same kind keep only the latest.
		if (items.length && items[0].t === entry.t) items.shift();

		entry.ts = Date.now();
		items.unshift(entry);
		write(items.slice(0, MAX));
	}

	window.AayatunRecent = {
		list: list,
		map: map,
		clear: function () {
			try { localStorage.removeItem(KEY); } catch (e) {}
		},
		// The confirmed clear button wipes the chips and the exploration map.
		clearAll: function () {
			try { localStorage.removeItem(KEY); } catch (e) {}
			try { localStorage.removeItem(MAP_KEY); } catch (e) {}
		}
	};

	document.addEventListener('aayatun:verse', function (evt) {
		var d = evt.detail || {};
		if (d.surah && d.verse) trackVerse(d.surah, d.verse, d.name);
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', record);
	} else {
		record();
	}
})();
