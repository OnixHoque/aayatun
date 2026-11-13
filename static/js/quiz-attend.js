/*
 * Quran Quiz — per-verse attendance bitset.
 *
 * One bit per verse, in canonical mushaf order (0 = 1:1 … 6235 = 114:6).
 * Set when a 5-question round is completed (answered or timed out), so the
 * quiz can work through every verse before any repeat appears; the Map
 * renders the same bits as its "Show Quiz Attendance" mode.
 *
 * Stored under localStorage['aayatun_quiz_done_v1'] as { b: base64 } with the
 * bytes packed 8 verses per byte, little-endian within each byte.
 */
(function () {
	'use strict';

	var KEY = 'aayatun_quiz_done_v1';
	var BITS = 6236;
	var BYTES = Math.ceil(BITS / 8);

	function toB64(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		try { return btoa(s); } catch (e) { return ''; }
	}

	function fromB64(text, length) {
		var out = new Uint8Array(length);
		try {
			var raw = atob(text || '');
			var n = Math.min(raw.length, length);
			for (var i = 0; i < n; i++) out[i] = raw.charCodeAt(i);
		} catch (e) {}
		return out;
	}

	function blank() { return new Uint8Array(BYTES); }

	function load() {
		var bits = blank();
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
			if (raw && typeof raw.b === 'string') {
				bits = fromB64(raw.b, BYTES);
			}
		} catch (e) {}
		return bits;
	}

	function save(bits) {
		try { localStorage.setItem(KEY, JSON.stringify({ b: toB64(bits) })); } catch (e) {}
	}

	function isSet(bits, i) {
		return i >= 0 && i < BITS && (bits[i >> 3] & (1 << (i & 7))) !== 0;
	}

	function set(bits, i) {
		if (i >= 0 && i < BITS) bits[i >> 3] |= (1 << (i & 7));
	}

	window.AayatunQuizAttend = {
		KEY: KEY,
		load: load,
		blank: blank,
		save: save,
		isSet: isSet,
		set: set,
		count: function () {
			var bits = load(), n = 0;
			for (var i = 0; i < BITS; i++) if (isSet(bits, i)) n++;
			return n;
		},
		// Returns true when the bit was newly set (first attendance).
		mark: function (i) {
			var bits = load();
			var fresh = !isSet(bits, i);
			if (fresh) { set(bits, i); save(bits); }
			return fresh;
		},
		clear: function () { try { localStorage.removeItem(KEY); } catch (e) {} },
		b64: function () { return toB64(load()); },
		fromB64: fromB64
	};
})();
