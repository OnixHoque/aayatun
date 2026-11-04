/* Shared QCF (King Fahd Complex colored mushaf) font loader.
 *
 * The verse page, the surah mushaf (/mushaf/<surah>) and the mushaf page
 * (/page/<n>) all use the same per-page COLRv1 fonts and the same persisted
 * on/off choice (localStorage['ayahTajweedOn']).
 *
 *   QcfFont.get()            true / false / null (never chosen)
 *   QcfFont.setOn(on)        persist the choice
 *   QcfFont.isOn()           persisted choice, false when unset
 *   QcfFont.supports()       browser can do font-palette + FontFace
 *   QcfFont.load(page)       Promise<FontFace>; shared, cached
 *   QcfFont.isLoaded(page)   synchronous check
 *   QcfFont.apply(el, page)  add the font + theme palette to an element
 *   QcfFont.clear(el)        remove them again
 *
 * Elements painted with apply() carry .qcf-ayah and data-qcf-page; the
 * MutationObserver below re-applies the light/dark palette whenever
 * html.dark-theme changes.
 */
window.QcfFont = (function () {
	var KEY = 'ayahTajweedOn';
	var root = document.documentElement;
	var fontCache = {};      // page -> FontFace
	var pending = {};        // page -> Promise<FontFace>
	var palettes = {};       // page -> <style>

	function get()
	{
		try
		{
			var v = localStorage.getItem(KEY);
			return v === null ? null : v === '1';
		}
		catch (e) { return null; }
	}

	function isOn()
	{
		return get() === true;
	}

	function setOn(on)
	{
		try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
	}

	function supports()
	{
		return !!(window.CSS && CSS.supports && CSS.supports('font-palette', 'normal') &&
			window.FontFace);
	}

	function family(page) { return 'QCF-V4-' + page; }

	function isDark() { return root.classList.contains('dark-theme'); }

	function paletteVar(page)
	{
		return (isDark() ? '--qcf-dark-' : '--qcf-light-') + page;
	}

	// @font-palette-values names are global, so every page needs its own pair.
	function ensurePalette(page)
	{
		if (palettes[page]) return;
		var st = document.createElement('style');
		var fam = family(page);
		st.textContent =
			"@font-palette-values --qcf-light-" + page + " { font-family:'" + fam + "'; base-palette:0; } " +
			"@font-palette-values --qcf-dark-" + page + " { font-family:'" + fam + "'; base-palette:1; }";
		document.head.appendChild(st);
		palettes[page] = st;
	}

	function load(page)
	{
		if (!page || !supports())
			return Promise.reject(new Error('unsupported'));
		if (fontCache[page]) return Promise.resolve(fontCache[page]);
		if (pending[page]) return pending[page];
		ensurePalette(page);
		var face = new FontFace(family(page), "url('/font/v4/" + page + ".woff2') format('woff2')");
		pending[page] = face.load().then(function (loaded)
		{
			document.fonts.add(loaded);
			fontCache[page] = loaded;
			delete pending[page];
			return loaded;
		}, function (err)
		{
			delete pending[page];
			throw err;
		});
		return pending[page];
	}

	function isLoaded(page)
	{
		return !!fontCache[page];
	}

	function apply(el, page)
	{
		if (!el || !page) return;
		el.classList.add('qcf-ayah');
		el.setAttribute('data-qcf-page', page);
		el.style.fontFamily = "'" + family(page) + "', 'Scheherazade', serif";
		el.style.fontPalette = paletteVar(page);
	}

	function clear(el)
	{
		if (!el) return;
		el.classList.remove('qcf-ayah');
		el.removeAttribute('data-qcf-page');
		el.style.removeProperty('font-family');
		el.style.removeProperty('font-palette');
	}

	function refreshPalettes()
	{
		var els = document.querySelectorAll('.qcf-ayah[data-qcf-page]');
		for (var i = 0; i < els.length; i++)
		{
			var p = els[i].getAttribute('data-qcf-page');
			if (p) els[i].style.fontPalette = paletteVar(p);
		}
	}

	if (window.MutationObserver)
	{
		new MutationObserver(refreshPalettes).observe(root,
			{ attributes: true, attributeFilter: ['class'] });
	}

	return {
		KEY: KEY,
		get: get,
		isOn: isOn,
		setOn: setOn,
		supports: supports,
		family: family,
		paletteVar: paletteVar,
		load: load,
		isLoaded: isLoaded,
		apply: apply,
		clear: clear,
		refreshPalettes: refreshPalettes
	};
})();
