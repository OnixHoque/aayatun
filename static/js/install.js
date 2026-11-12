/*
 * Home-screen install button for the standalone tools (Prayer Time and Daily
 * Counter). Each page links its own manifest, so the installed app opens that
 * page rather than the Aayatun index.
 *
 * Chromium fires `beforeinstallprompt`; the button then opens the real install
 * sheet. iOS has no such API, so the button explains Share → Add to Home
 * Screen instead. The button is hidden when the page already runs as an
 * installed app or inside an in-app browser, where installing is impossible.
 */
(function () {
	'use strict';

	var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-install-app]'));
	if (!buttons.length) return;

	// Both standalone pages are dark, so the help sheet uses one fixed dark
	// palette instead of reading their CSS variables.
	(function injectStyles() {
		if (document.getElementById('aayatun-install-style')) return;
		var style = document.createElement('style');
		style.id = 'aayatun-install-style';
		style.textContent =
			'html.aayatun-install-open{overflow:hidden}' +
			'#aayatun-install-help{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto;background:rgba(4,10,23,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}' +
			'#aayatun-install-help[hidden]{display:none!important}' +
			'.aayatun-install-card{position:relative;margin:auto;width:min(100%,390px);padding:24px 22px 20px;border:1px solid rgba(255,255,255,.16);border-radius:20px;background:#1b2b47;color:#e7eef9;box-shadow:0 24px 70px rgba(0,0,0,.5);font-family:"Open Sans",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5}' +
			'.aayatun-install-card:focus{outline:none}' +
			'.aayatun-install-card h2{margin:0 30px 6px 0;font-size:1.2rem;line-height:1.25}' +
			'.aayatun-install-sub{margin:0 0 14px;color:rgba(231,238,249,.7);font-size:.9rem}' +
			'.aayatun-install-card ol{margin:0;padding-left:1.2em}' +
			'.aayatun-install-card li{margin:0 0 9px}' +
			'.aayatun-install-close{position:absolute;top:10px;right:12px;width:34px;height:34px;padding:0;border:0;border-radius:50%;display:grid;place-items:center;background:transparent;color:inherit;font-size:1.5rem;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent}' +
			'.aayatun-install-close:focus,.aayatun-install-close:active{background:transparent;outline:none}' +
			'.aayatun-install-close:focus-visible{outline:2px solid rgba(231,238,249,.55);outline-offset:2px}' +
			'@media (hover:hover){.aayatun-install-close:hover{background:rgba(255,255,255,.1)}}' +
			'.aayatun-install-ok{margin-top:8px;min-height:42px;padding:9px 18px;border:1px solid rgba(255,255,255,.22);border-radius:12px;background:rgba(255,255,255,.1);color:inherit;font:inherit;font-weight:700;cursor:pointer}' +
			'@media (hover:hover){.aayatun-install-ok:hover{background:rgba(255,255,255,.17)}}';
		document.head.appendChild(style);
	})();

	function standalone() {
		try {
			if (window.navigator.standalone) return true;
			return !!(window.matchMedia && (
				window.matchMedia('(display-mode: standalone)').matches ||
				window.matchMedia('(display-mode: fullscreen)').matches
			));
		} catch (e) {
			return false;
		}
	}

	function isIos() {
		var ua = navigator.userAgent || '';
		if (/iPad|iPhone|iPod/.test(ua)) return true;
		// iPadOS 13+ reports a Mac desktop UA.
		return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
	}

	function inAppBrowser() {
		var ua = navigator.userAgent || '';
		return /FBAN|FBAV|Instagram|WhatsApp|Line\/|Twitter|Snapchat|MicroMessenger|Pinterest/i.test(ua);
	}

	function show() {
		buttons.forEach(function (b) { b.hidden = false; });
	}

	function hide() {
		buttons.forEach(function (b) { b.hidden = true; });
	}

	if (standalone() || inAppBrowser()) {
		hide();
		return;
	}

	var deferred = null;
	var help = null;
	var restoreTo = null;

	function buildHelp() {
		if (help) return help;
		var ios = isIos();
		var overlay = document.createElement('div');
		overlay.id = 'aayatun-install-help';
		overlay.hidden = true;

		var steps = ios ? [
			'Tap the Share button in Safari’s toolbar.',
			'Scroll down and choose “Add to Home Screen”.',
			'Tap “Add”, then open it from your Home Screen.'
		] : [
			'Open your browser menu (⋮ or the share icon).',
			'Choose “Install app” or “Add to Home Screen”.',
			'Confirm, then open it from your Home Screen.'
		];

		var card = document.createElement('div');
		card.className = 'aayatun-install-card';
		card.tabIndex = -1;
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		card.setAttribute('aria-labelledby', 'aayatun-install-title');

		var close = document.createElement('button');
		close.type = 'button';
		close.className = 'aayatun-install-close';
		close.setAttribute('aria-label', 'Close');
		close.textContent = '×';

		var title = document.createElement('h2');
		title.id = 'aayatun-install-title';
		title.textContent = 'Install this page';

		var sub = document.createElement('p');
		sub.className = 'aayatun-install-sub';
		sub.textContent = 'Add it to your Home Screen and open it in one tap.';

		var list = document.createElement('ol');
		steps.forEach(function (text) {
			var li = document.createElement('li');
			li.textContent = text;
			list.appendChild(li);
		});

		var ok = document.createElement('button');
		ok.type = 'button';
		ok.className = 'aayatun-install-ok';
		ok.textContent = 'Got it';

		card.appendChild(close);
		card.appendChild(title);
		card.appendChild(sub);
		card.appendChild(list);
		card.appendChild(ok);
		overlay.appendChild(card);
		document.body.appendChild(overlay);

		function dismiss() {
			overlay.hidden = true;
			document.documentElement.classList.remove('aayatun-install-open');
			if (restoreTo && restoreTo.focus) restoreTo.focus();
		}

		close.addEventListener('click', dismiss);
		ok.addEventListener('click', dismiss);
		overlay.addEventListener('click', function (evt) {
			if (evt.target === overlay) dismiss();
		});
		document.addEventListener('keydown', function (evt) {
			if (evt.key === 'Escape' && !overlay.hidden) dismiss();
		});

		help = { overlay: overlay, dismiss: dismiss, card: card };
		return help;
	}

	function openHelp() {
		var h = buildHelp();
		restoreTo = document.activeElement;
		h.overlay.hidden = false;
		document.documentElement.classList.add('aayatun-install-open');
		h.card.focus && h.card.focus();
	}

	buttons.forEach(function (btn) {
		btn.addEventListener('click', function () {
			if (deferred) {
				var prompt = deferred;
				deferred = null;
				try {
					var p = prompt.prompt();
					// Newer Chromium returns a promise that rejects when the
					// sheet is dismissed; a dismissal is not an error.
					if (p && p.catch) p.catch(function () {});
				} catch (e) {
					openHelp();
					return;
				}
				// A dismissed prompt leaves the button in place; only
				// appinstalled hides it for good.
				return;
			}
			openHelp();
		});
	});

	window.addEventListener('beforeinstallprompt', function (evt) {
		evt.preventDefault();
		deferred = evt;
		show();
	});

	window.addEventListener('appinstalled', function () {
		deferred = null;
		hide();
	});

	// No prompt event on iOS, and some desktop browsers never offer one, so
	// the button stays available and explains the manual route.
	show();
})();
