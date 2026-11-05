/*
 * Recently Read: a small localStorage history of the reading views.
 *
 * One entry per reading page (verse detail, mushaf page, full-arabic surah),
 * at most five, newest first. Runs of the same kind collapse to their newest
 * entry, so paging 42 -> 43 -> 44 leaves only "Page 44" in the list.
 *
 * Labels come from a server-rendered <meta name="aayatun-read"> in each
 * template ("type|key|label"), which avoids guessing from the document title.
 * The verse page is skipped inside the shared modal iframe: opening a modal
 * does not replace what the reader was reading on the page behind it.
 */
(function () {
	var KEY = 'aayatun_recent_reads_v1';
	var MAX = 5;
	var TYPES = { verse: 1, page: 1, mushaf: 1 };

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
			url: window.location.pathname.replace(/\/+$/, '') || '/',
			label: parts.slice(2).join('|')
		};
	}

	function record()
	{
		if (window.self !== window.top) return;
		var entry = currentEntry();
		if (!entry) return;

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
		clear: function () {
			try { localStorage.removeItem(KEY); } catch (e) {}
		}
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', record);
	} else {
		record();
	}
})();
