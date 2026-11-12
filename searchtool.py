"""FTS5-backed search over the Quran.

index_search(query, result_limit=10, field='all') -> (results, meta)
    results: list of dicts for the template (ser, surah, verse, surah_name,
        actual_translation, chips, ayah, translation, en_tafsir, bn_tafsir, ai)
    meta:    {'suggestions': [...], 'corrected': '...' | None}

The index lives in db/search.db (gitignored, built by build_search.py from
local files). Arabic is matched on a normalized form (diacritics removed,
alif/hamza unified) while results render the original Uthmani text, mapped
back through an index map. English and Bengali go through the same
normalizer. Ranking is BM25; the AI-explanation column is weighted lowest.
"""
import json
import os
import pickle
import re
import sqlite3
import threading

from markupsafe import Markup

import searchnorm
from searchnorm import BKTree, normalize, snippet

_DB = 'db/search.db'
_SYN_PATH = 'db/search_synonyms.json'
_VOCAB_PATH = 'db/search_vocab.pkl'

_ensure_lock = threading.Lock()
_glossary = None
_vocab = None
_bk_tree = None

FIELD_COLS = {
	'all': None,
	'ayah': 'ar_norm',
	'translation': 'en_norm',
	'en_tafsir': 'en_tafsir_norm',
	'bn_tafsir': 'bn_tafsir_norm',
	'ai': 'ai_norm',
}

# BM25 column order: ar_norm, en_norm, ai_norm, en_tafsir_norm, bn_tafsir_norm, surah_name
BM25 = 'bm25(docs, 10.0, 10.0, 1.5, 2.0, 2.0, 3.0)'

CHIP_LABELS = {
	'ar_norm': 'Verse',
	'en_norm': 'Translation',
	'en_tafsir_norm': 'Tafsir Ibn Kathir',
	'bn_tafsir_norm': 'Tafsir Abu Bakr Zakaria',
	'ai_norm': 'AI explanation',
}


def _ensure_db():
	if os.path.exists(_DB):
		return
	with _ensure_lock:
		if os.path.exists(_DB):
			return
		import build_search
		build_search.build()


def _connect():
	conn = sqlite3.connect(_DB)
	conn.row_factory = sqlite3.Row
	return conn


def _load_glossary():
	"""token -> normalized group members (single tokens + quoted phrases)."""
	global _glossary
	if _glossary is not None:
		return _glossary
	try:
		with open(_SYN_PATH) as fh:
			groups = json.load(fh).get('groups', [])
	except Exception:
		groups = []
	gloss = {}
	for group in groups:
		members = []
		for m in group:
			m_norm, _ = normalize(m)
			m_norm = m_norm.strip()
			if m_norm:
				members.append(m_norm)
		for m_norm in members:
			if ' ' not in m_norm:
				gloss[m_norm] = members
	_glossary = gloss
	return gloss


def _load_vocab():
	"""token -> frequency map (built by build_search.py)."""
	global _vocab
	if _vocab is not None:
		return _vocab
	with _ensure_lock:
		if _vocab is not None:
			return _vocab
		try:
			with open(_VOCAB_PATH, 'rb') as fh:
				_vocab = pickle.load(fh)
		except Exception:
			_vocab = {}
	return _vocab


def _load_bk_tree():
	"""BK-tree over the vocabulary, built on first use (zero-hit queries)."""
	global _bk_tree
	if _bk_tree is not None:
		return _bk_tree
	with _ensure_lock:
		if _bk_tree is not None:
			return _bk_tree
		vocab = _load_vocab()
		_bk_tree = BKTree(vocab.keys())
	return _bk_tree


_TOKEN_RE = re.compile(r'\b(?:AND|OR|NOT)\b|[()]|[^\s()"]+')


def _expand(tok, gloss):
	group = gloss.get(tok)
	if not group:
		return tok
	parts = []
	for m in group:
		if m == tok:
			continue
		parts.append('"' + m + '"' if ' ' in m else m)
	if not parts:
		return tok
	return '(' + ' OR '.join([tok] + parts) + ')'


def _expand_prefix(tok, gloss):
	"""Prefix (wildcard) form: `tok*`, OR'ed with the glossary group if any."""
	group = gloss.get(tok)
	if not group:
		return tok + '*'
	parts = []
	for m in group:
		if m == tok:
			continue
		parts.append('"' + m + '"' if ' ' in m else m)
	if not parts:
		return tok + '*'
	return '(' + ' OR '.join([tok + '*'] + parts) + ')'


def _bare(seg, gloss, highlight):
	"""Normalize a non-quoted segment into an FTS5 expression fragment."""
	out = []
	prev_operand = False
	for item in _TOKEN_RE.findall(seg):
		if item in ('AND', 'OR', 'NOT', '(', ')'):
			out.append(item)
			prev_operand = item == ')'
			continue
		prefix = item.endswith('*')
		n, _ = normalize(item[:-1] if prefix else item)
		for t in n.split():
			if not t:
				continue
			# Skip anything that would be re-parsed as an operator.
			if t in ('AND', 'OR', 'NOT'):
				continue
			highlight.append(t)
			group = gloss.get(t)
			if group:
				for m in group:
					highlight.append(m)
			atom = _expand_prefix(t, gloss) if prefix else _expand(t, gloss)
			if prev_operand and (not out or out[-1] not in ('AND', 'OR', 'NOT', '(')):
				out.append('OR')
			out.append(atom)
			prev_operand = True
	while out and out[0] == 'NOT':
		out.pop(0)
	while out and out[-1] in ('AND', 'OR', 'NOT'):
		out.pop()
	return ' '.join(out) if out else None


def _build_match(raw, col, gloss):
	"""Return (fts5_match_expr, highlight_terms) or (None, [])."""
	highlight = []
	parts = []
	last = 0
	for m in re.finditer(r'"([^"]*)"', raw):
		parts.append(_bare(raw[last:m.start()], gloss, highlight))
		q, _ = normalize(m.group(1))
		q = q.strip()
		if q:
			highlight.extend(q.split())
			parts.append('"' + q + '"')
		last = m.end()
	parts.append(_bare(raw[last:], gloss, highlight))
	expr = ' OR '.join(p for p in parts if p)
	if not expr:
		return None, []
	# De-duplicate highlight terms, longest first for nicer spans.
	seen, terms = set(), []
	for t in highlight:
		if t and t not in seen:
			seen.add(t)
			terms.append(t)
	terms.sort(key=len, reverse=True)
	if col:
		expr = f'{col} : ({expr})'
	else:
		# Emit one column-filtered clause per searchable column. In plain
		# (unfiltered) MATCH queries FTS5 computes bm25's IDF from the union
		# of all phrase sets, which flattens column weights; per-column OR'ed
		# clauses keep the weighted scores additive and restore the intended
		# translation-over-AI ranking.
		cols = ['ar_norm', 'en_norm', 'ai_norm', 'en_tafsir_norm', 'bn_tafsir_norm', 'surah_name']
		expr = ' OR '.join(f'{c} : ({expr})' for c in cols)
	return expr, terms


def _run_query(conn, match_expr, limit):
	"""Run the FTS5 query. `limit` is the SQL LIMIT: pass None for unlimited
	(use only when the caller guarantees a small row count)."""
	sql = f'SELECT surah, verse, surah_name, ar_orig, en, en_tafsir, bn_tafsir, ai, {BM25} AS score FROM docs WHERE docs MATCH ? ORDER BY score'
	if limit is None:
		return conn.execute(sql, (match_expr,)).fetchall()
	return conn.execute(sql + ' LIMIT ?', (match_expr, int(limit))).fetchall()


# Hard cap on rendered rows: "Show all results" with a broad query would
# otherwise fetch and highlight thousands of rows server-side.
TRUNC_MAX = 500


def _run_trigram(conn, raw, limit):
	"""Substring fallback for zero-hit queries (Arabic roots, partial words)."""
	n, _ = normalize(raw)
	toks = [t for t in n.split() if len(t) >= 3]
	if not toks:
		return []
	expr = ' AND '.join(toks)
	try:
		rows = conn.execute(
			'SELECT surah, verse FROM docs_trgm WHERE docs_trgm MATCH ? LIMIT ?',
			(expr, limit if limit is not None else TRUNC_MAX + 1)).fetchall()
	except sqlite3.OperationalError:
		return []
	if not rows:
		return []
	keys = [(r['surah'], r['verse']) for r in rows]
	ph = ','.join('(?,?)' for _ in keys)
	args = [x for k in keys for x in k]
	sql = f'SELECT surah, verse, surah_name, ar_orig, en, en_tafsir, bn_tafsir, ai FROM docs WHERE (surah, verse) IN (VALUES {ph})'
	try:
		full = conn.execute(sql, args).fetchall()
	except sqlite3.OperationalError:
		# Older SQLite without row-value IN (VALUES): fetch one by one.
		full = [conn.execute(
			'SELECT surah, verse, surah_name, ar_orig, en, en_tafsir, bn_tafsir, ai FROM docs WHERE surah=? AND verse=?',
			k).fetchone() for k in keys]
	full = [r for r in full if r]
	if limit is not None:
		full = full[:int(limit)]
	return full


_CHIP_TO_RAW = {
	'ar_norm': 'ar_orig',
	'en_norm': 'en',
	'en_tafsir_norm': 'en_tafsir',
	'bn_tafsir_norm': 'bn_tafsir',
	'ai_norm': 'ai',
}

_CHIP_TO_ITEM = {
	'ar_norm': 'ayah',
	'en_norm': 'translation',
	'en_tafsir_norm': 'en_tafsir',
	'bn_tafsir_norm': 'bn_tafsir',
	'ai_norm': 'ai',
}


def _matched_columns(row, terms):
	chips = []
	for col in CHIP_LABELS:
		field = _CHIP_TO_RAW[col]
		text = row[field] or ''
		if not text:
			continue
		n, _ = normalize(text)
		if any(t in n for t in terms):
			chips.append(col)
	return chips


def _format(rows, highlight_terms, offset=0):
	results = []
	for i, r in enumerate(rows, offset + 1):
		matched = _matched_columns(r, highlight_terms) if highlight_terms else ['ar_norm', 'en_norm']
		terms = highlight_terms
		def field(col):
			return r[_CHIP_TO_RAW[col]] or ''

		item = {
			'ser': str(i),
			'surah': r['surah'],
			'verse': r['verse'],
			'surah_name': r['surah_name'] or '',
			'actual_translation': r['en'] or '',
			'chips': [CHIP_LABELS[c] for c in matched],
			'ayah': '',
			'translation': '',
			'en_tafsir': '',
			'bn_tafsir': '',
			'ai': '',
		}
		for col in matched:
			item[_CHIP_TO_ITEM[col]] = Markup(snippet(field(col), terms))
		results.append(item)
	return results


def _correct_query(raw, max_tokens=6):
	"""Edit-distance correction for zero-hit queries.

	Returns a list of normalized replacement tokens (same length/order as the
	input) or None when no useful correction exists.
	"""
	n, _ = normalize(raw)
	vocab = _load_vocab()
	if not vocab:
		return None
	corrected, changed = [], False
	for t in n.split()[:max_tokens]:
		if len(t) < 4:
			corrected.append(t)
			continue
		max_dist = 2 if len(t) >= 6 else 1
		found = _load_bk_tree().search(t, max_dist)
		# Best candidate: smallest distance, then most frequent word.
		found.sort(key=lambda d_w: (d_w[0], -vocab.get(d_w[1], 0)))
		best = next((w for d, w in found if w != t), None)
		if best:
			corrected.append(best)
			changed = True
		else:
			corrected.append(t)
	return corrected if changed else None


def index_search(search_query, result_limit=10, dirname=None, search_fields=None, field=None):
	_ensure_db()
	field = (field or 'all').lower()
	col = FIELD_COLS.get(field)
	raw = (search_query or '').strip()
	meta = {'suggestions': [], 'corrected': None}
	if not raw:
		return [], meta

	gloss = _load_glossary()
	match_expr, terms = _build_match(raw, col, gloss)
	meta['truncated'] = False
	# SQL fetch limit: one extra row so we can detect that "show all" overran
	# the render cap.
	need_all = result_limit is None
	sql_limit = (TRUNC_MAX + 1) if need_all else result_limit
	conn = _connect()
	try:
		rows = []
		if match_expr:
			try:
				rows = _run_query(conn, match_expr, sql_limit)
			except sqlite3.OperationalError:
				# Malformed boolean/paren mix the user typed: plain OR of tokens.
				n, _ = normalize(raw)
				toks = [t for t in n.split() if t]
				fb = ' OR '.join(toks)
				if col:
					fb = f'{col} : ({fb})'
				try:
					rows = _run_query(conn, fb, sql_limit)
					terms = toks
				except sqlite3.OperationalError:
					rows = []
		if not rows:
			tri = _run_trigram(conn, raw, sql_limit)
			if tri:
				rows = tri
				terms = terms or normalize(raw)[0].split()
			else:
				corrected = _correct_query(raw)
				if corrected:
					n2 = ' '.join(corrected)
					m2, t2 = _build_match(n2, col, gloss)
					if m2:
						try:
							rows = _run_query(conn, m2, sql_limit)
						except sqlite3.OperationalError:
							rows = []
					if rows:
						meta['corrected'] = n2
						terms = t2
					else:
						meta['suggestions'] = corrected
		if need_all and len(rows) > TRUNC_MAX:
			rows = rows[:TRUNC_MAX]
			meta['truncated'] = True
		return _format(rows, terms), meta
	finally:
		conn.close()


# Legacy helpers kept for compatibility with anything importing them.
def process_result(res, col):
	return res[col]
