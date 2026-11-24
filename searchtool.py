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
from contextlib import closing
from pathlib import Path
from functools import lru_cache

from markupsafe import Markup

import searchnorm
from searchnorm import BKTree, normalize, snippet

_DB = 'db/search.db'
_SYN_PATH = 'db/search_synonyms.json'
_VOCAB_PATH = 'db/search_vocab.pkl'
_MORPH_PATH = 'db2/quran_metadata.db'

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
_ALL_COLUMNS = ['ar_norm', 'en_norm', 'ai_norm', 'en_tafsir_norm', 'bn_tafsir_norm', 'surah_name']
_CONTENT_COLUMNS = _ALL_COLUMNS[:-1]
_ENGLISH_STEM_COLUMNS = ['en_norm', 'ai_norm', 'en_tafsir_norm']
SEARCH_CROSS_FIELD_AND = True
SEARCH_ENGLISH_STEMMING = True
SEARCH_AI_TAFSIR_TIERS = True
SEARCH_MMR_LAMBDA = 0.7
SEARCH_TOP5_COVERAGE = True
MMR_CANDIDATE_POOL = 50

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
	conn = sqlite3.connect(_DB, timeout=60)
	conn.row_factory = sqlite3.Row
	return conn


def _ensure_root_index(conn):
	"""Build the root-to-verse index once from the app's trusted metadata."""
	if conn.execute("SELECT 1 FROM sqlite_master WHERE name='root_occurrences'").fetchone():
		return
	metadata = Path(_MORPH_PATH).resolve()
	if not metadata.is_file():
		raise FileNotFoundError('Verse morphology metadata is unavailable')
	conn.execute('BEGIN IMMEDIATE')
	try:
		if conn.execute("SELECT 1 FROM sqlite_master WHERE name='root_occurrences'").fetchone():
			conn.commit()
			return
		conn.execute('CREATE TABLE root_occurrences (root TEXT NOT NULL, docid INTEGER NOT NULL, '
		             'word TEXT NOT NULL, PRIMARY KEY (root, docid, word)) WITHOUT ROWID')
		docids = {(row['surah'], row['verse']): row['rowid'] for row in
		          conn.execute('SELECT rowid, surah, verse FROM docs')}
		with closing(sqlite3.connect(metadata.as_uri() + '?mode=ro', uri=True)) as source:
			seen = set()
			for surah, verse, data in source.execute('SELECT surah, verse, data FROM verses'):
				key = (surah, verse)
				if key not in docids:
					raise ValueError('Morphology and search index verses do not match')
				seen.add(key)
				morph = pickle.loads(data).get('morph')
				if not morph:
					raise ValueError('Verse morphology is incomplete')
				for item in morph:
					root, _ = normalize(item.get('root') or '')
					word, _ = normalize(item.get('word') or '')
					if root and word:
						conn.execute('INSERT OR IGNORE INTO root_occurrences VALUES (?, ?, ?)',
						             (root.replace(' ', ''), docids[key], word))
			if seen != set(docids):
				raise ValueError('Morphology and search index verses do not match')
		conn.commit()
	except Exception:
		conn.rollback()
		raise


def _surah_number(conn, name):
	"""Resolve a unique surah name through its FTS index, not a docs table scan."""
	if name.isdecimal():
		return int(name) if 1 <= int(name) <= 114 else None
	wanted = normalize(name)[0].strip()
	if not wanted:
		return None
	variants = {wanted}
	if wanted.startswith(('al', 'an', 'ar', 'as', 'az')):
		variants.add(wanted[2:])
	variants |= {value[:-1] for value in variants if value.endswith('h')}
	matches = set()
	for variant in variants:
		rows = conn.execute(
			'SELECT surah FROM docs WHERE docs MATCH ? GROUP BY surah LIMIT 2',
			(f'surah_name : ("{variant}"*)',)).fetchall()
		matches.update(row['surah'] for row in rows)
		if len(matches) > 1:
			return None
	return next(iter(matches)) if len(matches) == 1 else None


def _search_root(raw, field, limit, meta):
	"""Handle root:رحم and optional surah:fatiha as an explicit search mode."""
	parts = raw.split()
	roots = [part[5:] for part in parts if part.lower().startswith('root:')]
	surahs = [part[6:] for part in parts if part.lower().startswith('surah:')]
	if len(roots) != 1 or len(surahs) > 1 or len(parts) != len(roots) + len(surahs):
		meta['error'] = 'Use root:رحم, optionally with surah:fatiha.'
		return [], meta
	root = normalize(roots[0])[0].replace(' ', '')
	if not re.fullmatch(r'[\u0621-\u064a]{2,5}', root) or field not in ('all', 'ayah'):
		meta['error'] = 'Enter an Arabic root and select the entire Quran or the Arabic verse.'
		return [], meta
	conn = _connect()
	try:
		surah = _surah_number(conn, surahs[0]) if surahs else None
		if surahs and surah is None:
			meta['error'] = 'Surah name is unknown or ambiguous. Use a surah number instead.'
			return [], meta
		try:
			_ensure_root_index(conn)
		except (OSError, sqlite3.Error, ValueError, pickle.PickleError, EOFError):
			meta['error'] = 'Arabic root search is unavailable because verse morphology could not be loaded.'
			return [], meta
		condition = ' AND docs.surah = ?' if surah is not None else ''
		params = [root] + ([surah] if surah is not None else [])
		cap = TRUNC_MAX + 1 if limit is None else max(0, limit)
		rows = conn.execute(
			'SELECT docs.rowid, docs.surah, docs.verse, docs.surah_name, docs.ar_orig, '
			'docs.en, docs.en_tafsir, docs.bn_tafsir, docs.ai, '
			'group_concat(root_occurrences.word, \' \') AS root_words '
			'FROM root_occurrences JOIN docs ON docs.rowid = root_occurrences.docid '
			'WHERE root_occurrences.root = ?' + condition +
			' GROUP BY docs.rowid ORDER BY docs.surah, docs.verse LIMIT ?', params + [cap]).fetchall()
		if limit is None and len(rows) > TRUNC_MAX:
			rows = rows[:TRUNC_MAX]
			meta['truncated'] = True
		results = []
		for row in rows:
			item = _format([row], row['root_words'].split(), offset=len(results))[0]
			item['chips'] = ['Verse']
			item['en_tafsir'] = item['bn_tafsir'] = item['ai'] = ''
			if row['en']:
				item['chips'].append('Translation')
				item['translation'] = Markup(snippet(row['en'], []))
			results.append(item)
		return results, meta
	finally:
		conn.close()


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


def _bare(seg, gloss, highlight, join='OR'):
	"""Normalize a non-quoted segment into an FTS5 expression fragment.

	Bare operands with no explicit operator between them are OR'ed by default
	(legacy parity); with join='AND' they are AND'ed (the full-match tier)."""
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
				out.append(join)
			out.append(atom)
			prev_operand = True
	while out and out[0] == 'NOT':
		out.pop(0)
	while out and out[-1] in ('AND', 'OR', 'NOT'):
		out.pop()
	return ' '.join(out) if out else None


def _build_match(raw, col, gloss, join='OR'):
	"""Return (fts5_match_expr, highlight_terms) or (None, [])."""
	highlight = []
	parts = []
	last = 0
	for m in re.finditer(r'"([^"]*)"', raw):
		parts.append(_bare(raw[last:m.start()], gloss, highlight, join))
		q, _ = normalize(m.group(1))
		q = q.strip()
		if q:
			highlight.extend(q.split())
			parts.append('"' + q + '"')
		last = m.end()
	parts.append(_bare(raw[last:], gloss, highlight, join))
	expr = f' {join} '.join(p for p in parts if p)
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
		expr = ' OR '.join(f'{c} : ({expr})' for c in _ALL_COLUMNS)
	return expr, terms


def _run_query(conn, match_expr, limit):
	"""Run the FTS5 query. `limit` is the SQL LIMIT: pass None for unlimited
	(use only when the caller guarantees a small row count)."""
	sql = f'SELECT rowid AS rowid, surah, verse, surah_name, ar_orig, en, en_tafsir, bn_tafsir, ai, {BM25} AS score FROM docs WHERE docs MATCH ? ORDER BY score'
	if limit is None:
		return conn.execute(sql, (match_expr,)).fetchall()
	return conn.execute(sql + ' LIMIT ?', (match_expr, int(limit))).fetchall()


def _plain_keywords(raw):
	"""Normalized keywords for the automatic multi-word tiers."""
	if re.search(r'["()*]|\b(?:AND|OR|NOT)\b', raw):
		return []
	normalized, _ = normalize(raw)
	words = normalized.split()
	return words if 2 <= len(words) <= 12 else []


def _cross_field_expr(words, columns, gloss, prefix_latin=False):
	"""Require every keyword, allowing each one to match a different column."""
	field_set = '{' + ' '.join(columns) + '}'
	parts = []
	for word in words:
		if prefix_latin and re.fullmatch(r'[a-z]+', word) and len(word) >= 4:
			parts.append(f'{field_set} : ({_expand_prefix(word, gloss)})')
		else:
			parts.append(f'{field_set} : ({_expand(word, gloss)})')
	return ' AND '.join(parts)


def _surah_cross_field_exprs(conn, words, gloss):
	"""Scope a recognized surah name while matching other terms across fields."""
	for index, word in enumerate(words):
		if _surah_number(conn, word) is None:
			continue
		remaining = words[:index] + words[index + 1:]
		if not remaining:
			continue
		name = f'surah_name : ({_expand(word, gloss)})'
		exact = _cross_field_expr(remaining, _CONTENT_COLUMNS, gloss)
		prefix = _cross_field_expr(remaining, _CONTENT_COLUMNS, gloss, prefix_latin=True)
		yield name + ' AND ' + exact
		if prefix != exact:
			yield name + ' AND ' + prefix


def _latin_keywords(raw):
	words = _plain_keywords(raw)
	return words if words and all(re.fullmatch(r'[a-z]+', word) for word in words) else []


def _phrase_columns(words, col):
	"""Phrase-match only the content fields relevant to the query scripts."""
	if col:
		return [col]
	normalized = ' '.join(words)
	columns = []
	if re.search(r'[\u0600-\u06ff]', normalized):
		columns.append('ar_norm')
	if re.search(r'[a-z]', normalized):
		columns.extend(_ENGLISH_STEM_COLUMNS)
	if re.search(r'[\u0980-\u09ff]', normalized):
		columns.append('bn_tafsir_norm')
	return columns


def _english_stem_columns(conn):
	if conn is None or not conn.execute(
			"SELECT 1 FROM sqlite_master WHERE name='english_stem'").fetchone():
		return []
	current = [row[1] for row in conn.execute('PRAGMA table_info(english_stem)')]
	return [column for column in _ENGLISH_STEM_COLUMNS if column in current]


def _stem_expr(words, columns, gloss, join='AND'):
	expanded = [_expand(word, gloss) for word in words]
	if len(columns) == 1:
		return f'{columns[0]} : (' + f' {join} '.join(expanded) + ')'
	field_set = '{' + ' '.join(columns) + '}'
	return f' {join} '.join(
		f'{field_set} : ({term})' for term in expanded)


def _surah_stem_tiers(conn, words, columns, gloss):
	for index, word in enumerate(words):
		surah = _surah_number(conn, word)
		if surah is None:
			continue
		remaining = words[:index] + words[index + 1:]
		if remaining:
			yield _stem_expr(remaining, columns, gloss), surah


def _mmr_keywords(raw, col, limit):
	"""Keywords eligible for field-aware coverage-first lexical MMR reranking."""
	if col not in (None, 'en_norm', 'ai_norm', 'en_tafsir_norm'):
		return []
	if limit is None or limit <= 0:
		return []
	if not isinstance(SEARCH_MMR_LAMBDA, (int, float)) or not 0 < SEARCH_MMR_LAMBDA < 1:
		return []
	return _latin_keywords(raw)


def _row_has_exact_term(row, term, col=None):
	fields = ([col] if col else
		  ['ar_orig', 'en', 'ai', 'en_tafsir', 'bn_tafsir', 'surah_name'])
	for field in fields:
		if field not in row.keys():
			continue
		normalized, _ = normalize(row[field] or '')
		if term in normalized.split():
			return True
	return False


def _matched_term_masks(conn, words, rows, col=None):
	"""Return query-term bitmasks using Porter matches in the selected scope."""
	masks = {row['rowid']: 0 for row in rows}
	rowids = list(masks)
	if not rowids:
		return []
	placeholders = ','.join('?' for _ in rowids)
	stem_columns = _english_stem_columns(conn)
	if col is not None:
		stem_columns = [col] if col in stem_columns else []
	for index, word in enumerate(words):
		if re.fullmatch(r'[a-z]+', word) and stem_columns:
			field_set = (stem_columns[0] if len(stem_columns) == 1 else
					 '{' + ' '.join(stem_columns) + '}')
			matches = {row[0] for row in conn.execute(
				'SELECT rowid FROM english_stem WHERE english_stem MATCH ? '
				'AND rowid IN (' + placeholders + ')',
				[f'{field_set} : ({word})'] + rowids)}
			if col is None:
				matches.update(row['rowid'] for row in rows
						   if _row_has_exact_term(row, word, 'surah_name'))
		else:
			matches = {row['rowid'] for row in rows
					   if _row_has_exact_term(row, word, col)}
		for rowid in matches:
			masks[rowid] |= 1 << index
	return [masks[row['rowid']] for row in rows]


def _mask_size(mask):
	return bin(mask).count('1')


def _jaccard(left, right):
	union = left | right
	return _mask_size(left & right) / _mask_size(union) if union else 0.0


def _mmr_rerank(rows, words, masks, limit, lambda_value=None, top5_coverage=False,
				 preserve_baseline=False):
	"""Greedily balance coverage, early term diversity, and redundancy."""
	if not rows or limit <= 0:
		return []
	if not words:
		return rows[:limit]
	if lambda_value is None:
		lambda_value = SEARCH_MMR_LAMBDA
	remaining = list(range(len(rows)))
	selected, selected_masks, selected_indices = [], [], []
	covered_mask = 0
	full_mask = (1 << len(words)) - 1
	while remaining and len(selected) < limit:
		candidates = remaining
		if top5_coverage and 0 < len(selected) < 5:
			# Preserve complete matches, then prefer new term coverage.
			complete = [
				index for index in remaining
				if (masks[index] if index < len(masks) else 0) == full_mask]
			if complete:
				candidates = complete
			else:
				prioritized = [
					index for index in remaining
					if (masks[index] if index < len(masks) else 0) & ~covered_mask]
				if prioritized:
					candidates = prioritized
		best_index, best_key = None, None
		for index in candidates:
			mask = masks[index] if index < len(masks) else 0
			coverage = _mask_size(mask) / len(words)
			relevance = 2 * coverage + 1 / (1 + index)
			similarity = max((_jaccard(mask, chosen) for chosen in selected_masks), default=0.0)
			score = lambda_value * relevance - (1 - lambda_value) * similarity
			key = (score, -index)
			if best_key is None or key > best_key:
				best_index, best_key = index, key
		chosen_mask = masks[best_index] if best_index < len(masks) else 0
		selected.append(rows[best_index])
		selected_masks.append(chosen_mask)
		selected_indices.append(best_index)
		covered_mask |= chosen_mask
		remaining.remove(best_index)
	if (top5_coverage and preserve_baseline and
			not any(mask == full_mask for mask in masks)):
		# Translation paraphrases can be lexically sparse. Keep the four
		# strongest literal matches stable and let coverage compete for the
		# remaining top-five slot instead of displacing all BM25 anchors.
		protected = list(range(min(4, limit, len(rows))))
		protected.extend(index for index in selected_indices if index not in protected)
		return [rows[index] for index in protected[:limit]]
	return selected


def _ranked_tiers(raw, col, gloss, full_expr, match_expr, conn=None):
	"""Return (source, expression, surah) tiers in priority order."""
	queries = []

	def add(source, expr, surah=None):
		item = (source, expr, surah)
		if expr and item not in queries:
			queries.append(item)

	# Preserve the meaning of explicit FTS syntax and wildcard queries.
	words = _plain_keywords(raw)
	latin_words = _latin_keywords(raw)
	english_scope = col in (None, 'en_norm', 'ai_norm', 'en_tafsir_norm')
	stem_columns = _english_stem_columns(conn) if latin_words and english_scope else []
	stem_ready = bool(latin_words and SEARCH_ENGLISH_STEMMING and (
		(col is None and stem_columns == _ENGLISH_STEM_COLUMNS) or
		(col in ('en_norm', 'ai_norm', 'en_tafsir_norm') and col in stem_columns)))
	legacy_stem_ready = bool(latin_words and col == 'en_norm' and 'en_norm' in stem_columns)
	if words:
		normalized = ' '.join(words)
		phrase_text = '"' + ' '.join(words) + '"'
		columns = (_phrase_columns(words, col) if SEARCH_AI_TAFSIR_TIERS else
			   [col] if col else ['ar_norm', 'en_norm'])
		phrases = [_build_match(phrase_text, column, gloss)[0] for column in columns]
		phrase = ' OR '.join(p for p in phrases if p)
		if phrase:
			add('docs', phrase)
		# A Latin surah name and Arabic terms may occur in different fields.
		# Arabic prefixes support inflected words such as حمل in حملته.
		if not col and all(re.fullmatch(r'[a-z]+|[\u0600-\u06ff]+', word) for word in words):
			latin = [word for word in words if re.fullmatch(r'[a-z]+', word)]
			arabic = [word for word in words if re.fullmatch(r'[\u0600-\u06ff]+', word)]
			if latin and arabic and all(len(word) >= 3 for word in arabic):
				name_expr = ' AND '.join('"' + word + '"' for word in latin)
				exact_arabic = ' AND '.join('"' + word + '"' for word in arabic)
				arabic_expr = ' AND '.join('"' + word + '"*' for word in arabic)
				add('docs', f'surah_name : ({name_expr}) AND ar_norm : ({exact_arabic})')
				add('docs', f'surah_name : ({name_expr}) AND ar_norm : ({arabic_expr})')
		# In All fields, a bilingual query can describe the same verse in
		# its Arabic text, English translation and Bengali commentary.
		if not col:
			scripts = [r'[a-z]', r'[\u0600-\u06ff]', r'[\u0980-\u09ff]']
			if sum(bool(re.search(script, normalized)) for script in scripts) >= 2:
				combined = _bare(raw, gloss, [], join='AND')
				columns = 'ar_norm en_norm'
				if re.search(r'[\u0980-\u09ff]', normalized):
					columns += ' bn_tafsir_norm'
				add('docs', '{' + columns + '} : (' + combined + ')')
		if stem_ready and conn is not None and col in (None, 'en_norm'):
			# A recognized surah can scope Translation matches without searching
			# commentary columns or treating the surah name as translated content.
			for expr, surah in _surah_stem_tiers(conn, latin_words, ['en_norm'], gloss):
				add('stem', expr, surah)
		if not col:
			if SEARCH_CROSS_FIELD_AND and conn is not None:
				for expr in _surah_cross_field_exprs(conn, words, gloss):
					add('docs', expr)
			if stem_ready and conn is not None:
				for expr, surah in _surah_stem_tiers(conn, latin_words, stem_columns, gloss):
					add('stem', expr, surah)
			if SEARCH_AI_TAFSIR_TIERS and latin_words:
				# English terms may be split between translation and commentary.
				add('docs', _cross_field_expr(latin_words, _ENGLISH_STEM_COLUMNS, gloss))
			if SEARCH_CROSS_FIELD_AND:
				generic = _cross_field_expr(words, _ALL_COLUMNS, gloss)
				add('docs', generic)
	add('docs', full_expr)
	if col == 'en_norm':
		# Literal Translation matches retain priority inside the bounded MMR
		# pool; stemming expands the candidate set without displacing it.
		add('docs', match_expr)
	if stem_ready:
		columns = stem_columns if col is None else [col]
		add('stem', _stem_expr(latin_words, columns, gloss))
		if col in ('en_norm', 'ai_norm', 'en_tafsir_norm'):
			add('stem', _stem_expr(latin_words, columns, gloss, join='OR'))
	elif legacy_stem_ready:
		add('stem', _stem_expr(latin_words, ['en_norm'], gloss, join='OR'))
	add('docs', match_expr)
	if stem_ready and col is None:
		add('stem', _stem_expr(latin_words, stem_columns, gloss, join='OR'))
	return queries


def _ranked_queries(raw, col, gloss, full_expr, match_expr, conn=None):
	"""Return docs-index retrieval tiers for compatibility and inspection."""
	return [expr for source, expr, _ in _ranked_tiers(
		raw, col, gloss, full_expr, match_expr, conn) if source == 'docs']


def _run_stem_query(conn, match_expr, limit, surah=None, col=None):
	table_columns = [row[1] for row in conn.execute('PRAGMA table_info(english_stem)')]
	highlights = ', '.join(
		f"highlight(english_stem, {index}, '[', ']') AS stem_{column}"
		for index, column in enumerate(table_columns)
		if col is None or column == col)
	if col is None:
		selected = ('docs.rowid AS rowid, docs.surah, docs.verse, docs.surah_name, '
			    'docs.ar_orig, docs.en, docs.ai, docs.en_tafsir, docs.bn_tafsir')
	else:
		raw = _CHIP_TO_RAW[col]
		selected = 'docs.rowid AS rowid, docs.surah, docs.verse, docs.surah_name, docs.en'
		if raw != 'en':
			selected += f', docs.{raw} AS {raw}'
	sql = ('SELECT ' + selected + (
		', ' + highlights if highlights else '') +
		' FROM english_stem JOIN docs ON docs.rowid = english_stem.rowid '
		'WHERE english_stem MATCH ?')
	params = [match_expr]
	if surah is not None:
		sql += ' AND docs.surah = ?'
		params.append(surah)
	sql += ' ORDER BY english_stem.rank, english_stem.rowid LIMIT ?'
	params.append(int(limit))
	return conn.execute(sql, params).fetchall()


def _merge_stem_metadata(row, stem_row):
	merged = dict(row)
	for key in stem_row.keys():
		if key.startswith('stem_'):
			merged[key] = stem_row[key]
	return merged


def _ranked_row_tiers(conn, raw, col, gloss, full_expr, match_expr, limit):
	for source, expr, surah in _ranked_tiers(raw, col, gloss, full_expr, match_expr, conn):
		rows = (_run_stem_query(conn, expr, limit, surah, col) if source == 'stem' else
				_run_query(conn, expr, limit))
		for row in rows:
			yield source, row


def _ranked_rows(conn, raw, col, gloss, full_expr, match_expr, limit):
	for _, row in _ranked_row_tiers(conn, raw, col, gloss, full_expr, match_expr, limit):
		yield row


def _baseline_all_rows(conn, raw, gloss, full_expr, match_expr, limit):
	"""Return the pre-FCS All-fields BM25 order for plain keyword queries."""
	words = _plain_keywords(raw)
	if not words:
		return []
	phrase_text = '"' + ' '.join(words) + '"'
	phrases = [_build_match(phrase_text, column, gloss)[0]
			   for column in ('ar_norm', 'en_norm')]
	queries = [' OR '.join(p for p in phrases if p), full_expr, match_expr]
	rows, seen = [], set()
	for expr in queries:
		if not expr:
			continue
		for row in _run_query(conn, expr, limit):
			key = (row['surah'], row['verse'])
			if key in seen:
				continue
			seen.add(key)
			rows.append(row)
			if len(rows) == limit:
				return rows
	return rows


def _translation_candidate_rows(conn, raw, gloss, full_expr, match_expr, limit):
	"""Keep literal top-five order and reserve the rest of the pool for stemming."""
	literal, stem = [], []
	positions = {}
	for source, row in _ranked_row_tiers(
			conn, raw, 'en_norm', gloss, full_expr, match_expr, limit):
		key = (row['surah'], row['verse'])
		if key in positions:
			if source == 'stem':
				target, index = positions[key]
				target[index] = _merge_stem_metadata(target[index], row)
			continue
		target = stem if source == 'stem' else literal
		if len(target) < limit:
			positions[key] = (target, len(target))
			target.append(row)
	baseline = literal[:min(5, limit)]
	rows = baseline + stem[:max(0, limit - len(baseline))]
	selected = {(row['surah'], row['verse']) for row in rows}
	for row in literal[len(baseline):]:
		key = (row['surah'], row['verse'])
		if key not in selected:
			rows.append(row)
			selected.add(key)
			if len(rows) == limit:
				break
	return rows


# Hard cap on rendered rows: "Show all results" with a broad query would
# otherwise fetch and highlight thousands of rows server-side.
TRUNC_MAX = 500


_trgm_available = None


def _trgm_ok(conn):
	"""True when the optional trigram table was built on this host (needs
	SQLite >= 3.34). Checked once per process."""
	global _trgm_available
	if _trgm_available is None:
		_trgm_available = bool(conn.execute(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='docs_trgm'"
		).fetchone())
	return _trgm_available


@lru_cache(maxsize=1)
def _english_words():
	return frozenset(Path(__file__).with_name('db').joinpath('english_words.txt').read_text(encoding='utf8').splitlines())


def _plain_english_query(raw):
	return bool(re.fullmatch(r"[A-Za-z\s,.;:!?'-]+", raw)) and not re.search(r'\b(?:AND|OR|NOT)\b', raw)


def _run_trigram(conn, raw, limit, col=None):
	"""Substring fallback for zero-hit queries in indexed trigram fields."""
	if col not in (None, 'ar_norm', 'en_norm') or not _trgm_ok(conn):
		return []
	n, _ = normalize(raw)
	toks = [t for t in n.split() if len(t) >= 3]
	if not toks:
		return []
	plain_english = _plain_english_query(raw)
	known = [t for t in n.split() if t in _english_words()] if plain_english and col in (None, 'en_norm') else []
	fragments = [t for t in toks if t not in known]
	if known and not fragments:
		return []
	expr = ' AND '.join(fragments if known else toks)
	if col or known:
		expr = f'{col or "en_norm"} : ({expr})'
	try:
		if known:
			word_expr = 'en_norm : (' + ' AND '.join(known) + ')'
			rows = conn.execute(
				'SELECT t.surah, t.verse FROM docs_trgm t JOIN docs d ON d.rowid=t.rowid '
				'WHERE docs_trgm MATCH ? AND docs MATCH ? LIMIT ?',
				(expr, word_expr, limit if limit is not None else TRUNC_MAX + 1)).fetchall()
		else:
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


def _matched_columns(row, terms, whole_terms=frozenset()):
	chips = []
	for col in CHIP_LABELS:
		field = _CHIP_TO_RAW[col]
		text = row[field] or ''
		if not text:
			continue
		n, imap = normalize(text)
		if searchnorm.spans_for(n, imap, terms, text, whole_terms if col in _ENGLISH_STEM_COLUMNS else frozenset()):
			chips.append(col)
	return chips


def _format(rows, highlight_terms, offset=0, col=None, whole_terms=frozenset()):
	results = []
	for i, r in enumerate(rows, offset + 1):
		if col:
			# Scoped retrieval already guarantees a match in this column.
			matched = [col] if r[_CHIP_TO_RAW[col]] else []
		elif highlight_terms:
			matched = _matched_columns(r, highlight_terms, whole_terms)
		else:
			matched = ['ar_norm', 'en_norm']
		field_terms = {column: list(highlight_terms) for column in matched}
		for column in _ENGLISH_STEM_COLUMNS:
			if col is not None and column != col:
				continue
			key = 'stem_' + column
			if key in r.keys():
				found = re.findall(r'\[([^\]]+)\]', r[key] or '')
				if found:
					field_terms.setdefault(column, []).extend(found)
					if column not in matched:
						matched.append(column)
		if 'stem_matches' in r.keys() and col in (None, 'en_norm'):
			found = re.findall(r'\[([^\]]+)\]', r['stem_matches'])
			if found:
				field_terms.setdefault('en_norm', []).extend(found)
				if 'en_norm' not in matched:
					matched.append('en_norm')
		matched = [column for column in CHIP_LABELS if column in matched]

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
		for matched_col in matched:
			text = r[_CHIP_TO_RAW[matched_col]] or ''
			item[_CHIP_TO_ITEM[matched_col]] = Markup(
				snippet(text, field_terms[matched_col], whole_terms=whole_terms if matched_col in _ENGLISH_STEM_COLUMNS else frozenset()))
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
	plain_english = _plain_english_query(raw) and len(n.split()) == 1
	for t in n.split()[:max_tokens]:
		if len(t) < 4 or (plain_english and t in _english_words()):
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
	meta = {'suggestions': [], 'corrected': None, 'truncated': False, 'error': None}
	if not raw:
		return [], meta
	if any(part.lower().startswith('root:') for part in raw.split()):
		return _search_root(raw, field, result_limit, meta)
	# Treat a recognized surah name followed by an annotated Arabic root as
	# a scoped root search. Other mixed queries retain the keyword path.
	parts = raw.split()
	if field == 'all' and len(parts) == 2 and re.fullmatch(r'[A-Za-z-]+', parts[0]):
		root, _ = normalize(parts[1])
		if re.fullmatch(r'[\u0621-\u064a]{2,5}', root):
			conn = _connect()
			try:
				surah = _surah_number(conn, parts[0])
			finally:
				conn.close()
			if surah is not None:
				root_results, root_meta = _search_root(
					f'surah:{surah} root:{root}', field, result_limit, meta.copy())
				if root_results:
					return root_results, root_meta

	gloss = _load_glossary()
	match_expr, terms = _build_match(raw, col, gloss)
	# Full-match tier: every token must be present somewhere. Docs matching
	# all words are merged in front of the partial-match tier (OR), so a
	# multi-word query always shows complete matches first.
	full_expr, _ = _build_match(raw, col, gloss, join='AND')
	# SQL fetch limit: one extra row so we can detect that "show all" overran
	# the render cap.
	need_all = result_limit is None
	mmr_words = _mmr_keywords(raw, col, result_limit)
	conn = _connect()
	try:
		stem_columns = _english_stem_columns(conn)
		if mmr_words and (col is None and stem_columns != _ENGLISH_STEM_COLUMNS or
				col is not None and col not in stem_columns):
			mmr_words = []
		sql_limit = MMR_CANDIDATE_POOL if mmr_words else ((TRUNC_MAX + 1) if need_all else result_limit)
		rows = []
		seen = set()
		baseline_rows = []
		if match_expr:
			try:
				if mmr_words and col == 'en_norm':
					rows = _translation_candidate_rows(
						conn, raw, gloss, full_expr, match_expr, sql_limit)
				else:
					positions = {}
					for source, row in _ranked_row_tiers(
							conn, raw, col, gloss, full_expr, match_expr, sql_limit):
						key = (row['surah'], row['verse'])
						if key in positions:
							if source == 'stem':
								rows[positions[key]] = _merge_stem_metadata(
									rows[positions[key]], row)
							continue
						if len(rows) < sql_limit:
							positions[key] = len(rows)
							rows.append(row)
							seen.add(key)
							if len(rows) == sql_limit:
								break
				if mmr_words and col is None and SEARCH_TOP5_COVERAGE:
					baseline_rows = _baseline_all_rows(
						conn, raw, gloss, full_expr, match_expr, 5)
					positions = {(row['surah'], row['verse']) for row in rows}
					for row in baseline_rows:
						key = (row['surah'], row['verse'])
						if key not in positions and len(rows) < sql_limit:
							rows.append(row)
							positions.add(key)
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
		else:
			rows = []
		if not rows:
			# MMR applies to ranked keyword candidates, not spelling/substring fallbacks.
			mmr_words = []
			tri = _run_trigram(conn, raw, sql_limit, col)
			if tri:
				rows = tri
				terms = terms or normalize(raw)[0].split()
			else:
				corrected = _correct_query(raw)
				if corrected:
					n2 = ' '.join(corrected)
					m2, t2 = _build_match(n2, col, gloss)
					m2_and, _ = _build_match(n2, col, gloss, join='AND')
					if m2:
						try:
							rows = []
							seen = set()
							if m2_and and m2_and != m2:
								rows = _run_query(conn, m2_and, sql_limit)
								seen = {(r['surah'], r['verse']) for r in rows}
							partial = _run_query(conn, m2, sql_limit)
							rows += [r for r in partial if (r['surah'], r['verse']) not in seen]
						except sqlite3.OperationalError:
							rows = []
					if rows:
						meta['corrected'] = n2
						terms = t2
					else:
						meta['suggestions'] = corrected
		if mmr_words and rows:
			masks = _matched_term_masks(conn, mmr_words, rows, col)
			preserve_baseline_top5 = False
			if baseline_rows:
				baseline_masks = _matched_term_masks(
					conn, mmr_words, baseline_rows, 'en_norm')
				covered = 0
				for mask in baseline_masks[:min(5, int(result_limit))]:
					covered |= mask
				preserve_baseline_top5 = covered == (1 << len(mmr_words)) - 1
			if preserve_baseline_top5:
				baseline_keys = {(row['surah'], row['verse']) for row in baseline_rows}
				rows = baseline_rows + [row for row in rows
					if (row['surah'], row['verse']) not in baseline_keys]
			else:
				rows = _mmr_rerank(
					rows, mmr_words, masks, min(int(result_limit), MMR_CANDIDATE_POOL),
					SEARCH_MMR_LAMBDA, top5_coverage=SEARCH_TOP5_COVERAGE,
					preserve_baseline=col == 'en_norm')
		if not need_all and len(rows) > result_limit:
			rows = rows[:result_limit]
		if need_all and len(rows) > TRUNC_MAX:
			rows = rows[:TRUNC_MAX]
			meta['truncated'] = True
		whole_terms = frozenset(t for t in terms if t in _english_words()) if _plain_english_query(raw) else frozenset()
		return _format(rows, terms, col=col, whole_terms=whole_terms), meta
	finally:
		conn.close()


# Legacy helpers kept for compatibility with anything importing them.
def process_result(res, col):
	return res[col]
