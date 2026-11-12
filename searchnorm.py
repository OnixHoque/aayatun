"""Shared text normalization and match highlighting for search.

The Arabic text is stored Uthmani (full tashkeel). The search index keeps a
normalized form of every field: combining marks (vowels, shadda, Quranic pause
signs) are dropped, the various alif forms are unified, and ya/ta-marbuta are
unified. The same normalization runs on the query, so plain text like
"بسم الله" matches "بِسْمِ ٱللَّهِ". Every normalized string is paired with an
index map (norm position -> original position) so matches can be highlighted
on the original, diacritized text.

The normalization is script-agnostic: it works for English (lowercased,
accents folded), Bengali (NFKD decomposes ড়/য় into র/য + nukta which is
dropped) and Arabic, so one code path handles the whole corpus.
"""
import html
import re
import unicodedata

# Character-level replacement table applied after per-char NFKD decomposition.
# Values are the normalized output for a single decomposed char ('' = drop).
_MAP = {
	'ٱ': 'ا',  # alef wasla
	'أ': 'ا',  # hamza above
	'إ': 'ا',  # hamza below
	'آ': 'ا',  # madda above
	'ٲ': 'ا',  # madda waw above
	'ٳ': 'ا',  # alef madda wavy
	'ٵ': 'ا',  # high hamza alef
	'ى': 'ي',  # alef maqsura
	'ئ': 'ي',  # ya with hamza
	'ة': 'ه',  # ta marbuta
	'ؤ': 'و',  # waw with hamza
	'ء': '',   # standalone hamza
	'ٴ': '',   # high hamza
	'ـ': '',   # tatweel (kashida)
}

_SPACE_RUN = re.compile(r'\s+')


def normalize(text):
	"""Return (normalized_string, index_map).

	index_map[i] is the offset in the *original* string of the char that
	produced normalized char i. It is monotonically non-decreasing, which is
	all the highlighter needs.
	"""
	out = []
	imap = []
	for i, ch in enumerate(text):
		for d in unicodedata.normalize('NFKD', ch):
			mapped = _MAP.get(d)
			if mapped is None:
				cat = unicodedata.category(d)
				if cat[0] == 'M' or cat == 'Cf':
					# Combining marks (harakat, nukta, Quranic signs) and
					# format chars (ZWJ, end-of-ayah ornament) are dropped.
					continue
				if cat[0] in ('L', 'N'):
					mapped = d
				else:
					mapped = ' '  # punctuation / symbols act as separators
			if not mapped:
				continue
			if mapped.isspace():
				if out and out[-1] != ' ':
					out.append(' ')
					imap.append(i)
				continue
			out.append(mapped.lower())
			imap.append(i)
	# Trim leading/trailing spaces (indices must stay monotone).
	s = ''.join(out)
	start = 0
	while start < len(s) and s[start] == ' ':
		start += 1
	end = len(s)
	while end > start and s[end - 1] == ' ':
		end -= 1
	return s[start:end], imap[start:end]


def spans_for(norm, imap, terms, orig=None):
	"""All (start, end) spans in the *original* string matching the terms.

	Spans are extended over any trailing combining marks in the original text,
	so a diacritized final letter renders fully inside the highlight.
	"""
	spans = []
	for t in terms:
		t = t.strip()
		if not t:
			continue
		pos = norm.find(t)
		while pos != -1:
			spans.append((imap[pos], imap[pos + len(t) - 1] + 1))
			pos = norm.find(t, pos + 1)
	if not spans:
		return []
	spans.sort()
	merged = [spans[0]]
	for s, e in spans[1:]:
		if s <= merged[-1][1]:
			merged[-1] = (merged[-1][0], max(merged[-1][1], e))
		else:
			merged.append((s, e))
	if orig is not None:
		extended = []
		for s, e in merged:
			while e < len(orig) and unicodedata.category(orig[e]).startswith('M'):
				e += 1
			extended.append((s, e))
		merged = extended
	return merged


def _render(orig, spans):
	"""HTML-escape orig, wrapping the given spans in <span class="match">."""
	parts = []
	pos = 0
	for s, e in spans:
		if s > pos:
			parts.append(html.escape(orig[pos:s]))
		parts.append('<span class="match">' + html.escape(orig[s:e]) + '</span>')
		pos = e
	if pos < len(orig):
		parts.append(html.escape(orig[pos:]))
	return ''.join(parts)


def highlight(orig, terms):
	"""Full field as HTML with matches wrapped in <span class="match">."""
	norm, imap = normalize(orig)
	return _render(orig, spans_for(norm, imap, terms, orig))


def snippet(orig, terms, width=240):
	"""Excerpt (~width chars) around the first match, as HTML.

	Falls back to the beginning of the field when nothing matches (the field
	only gets rendered for columns that matched, so this is rare).
	"""
	norm, imap = normalize(orig)
	spans = spans_for(norm, imap, terms, orig)
	if not spans:
		text = orig[:width]
		suffix = '…' if len(orig) > width else ''
		return html.escape(text) + suffix
	first = spans[0]
	lo = max(0, first[0] - width // 2)
	hi = min(len(orig), first[1] + width // 2)
	while lo > 0 and not orig[lo - 1].isspace():
		lo -= 1
	while hi < len(orig) and not orig[hi].isspace():
		hi += 1
	text = orig[lo:hi]
	part = [(max(lo, s) - lo, min(hi, e) - lo) for s, e in spans if e > lo and s < hi]
	prefix = '…' if lo > 0 else ''
	suffix = '…' if hi < len(orig) else ''
	return prefix + _render(text, part) + suffix


def levenshtein(a, b):
	"""Small, dependency-free edit distance (two-row DP)."""
	if a == b:
		return 0
	if not a:
		return len(b)
	if not b:
		return len(a)
	prev = list(range(len(b) + 1))
	for i, ca in enumerate(a, 1):
		cur = [i]
		for j, cb in enumerate(b, 1):
			cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
		prev = cur
	return prev[-1]


class BKTree:
	"""Metric tree for edit-distance neighborhood search.

	Used to answer "did you mean": given a misspelled token, find the closest
	known vocabulary tokens (distance <= 2) without scanning the vocabulary.
	"""

	def __init__(self, words=None):
		self.root = None
		if words:
			for w in words:
				self.add(w)

	def add(self, word):
		if self.root is None:
			self.root = [word, {}]
			return
		node = self.root
		while True:
			d = levenshtein(word, node[0])
			child = node[1].get(d)
			if child is None:
				node[1][d] = [word, {}]
				return
			node = child

	def search(self, word, max_dist):
		"""Return [(distance, token), ...] for all tokens within max_dist."""
		found = []
		if self.root is None:
			return found

		def visit(node):
			d = levenshtein(word, node[0])
			if d <= max_dist:
				found.append((d, node[0]))
			for dist, child in node[1].items():
				if d - max_dist <= dist <= d + max_dist:
					visit(child)

		visit(self.root)
		return found
