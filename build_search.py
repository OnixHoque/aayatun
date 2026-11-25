#!/usr/bin/env python3
"""Build the FTS5 search index and the "did you mean" vocabulary.

Run from the repo root:   python3 build_search.py

Outputs (both gitignored, regenerated any time):
  db/search.db        FTS5 index (docs, plus docs_trgm when the host's SQLite supports it)
  db/search_vocab.pkl token -> frequency map used for typo suggestions

The docs_trgm trigram table (substring fallback) is skipped automatically when
the host's SQLite lacks the trigram tokenizer (needs SQLite >= 3.34); keyword
search is otherwise unchanged, only substring fallback is lost there.

All sources are local files; no network calls. The heavy part is tokenizing
~30 MB of text, which takes a few seconds. searchtool.index_search() will
also run this automatically (once, guarded by a lock) when db/search.db is
missing, so a fresh clone can serve searches without a manual step.
"""
import json
import os
import pickle
import re
import sqlite3
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import searchnorm  # noqa: E402

DB_OUT = 'db/search.db'
VOCAB_OUT = 'db/search_vocab.pkl'

_tag_re = re.compile(r'<[^>]+>')
_url_re = re.compile(r'https?://\S+')
_ws_re = re.compile(r'\s+')


def strip_markup(text):
	import html
	text = _tag_re.sub(' ', text or '')
	text = html.unescape(text)
	return _ws_re.sub(' ', text).strip()


def load_ai_fields():
	"""Return the legacy combined AI text plus separate semantic fields."""
	ai = {}
	contexts = {}
	word_meanings = {}
	conn = sqlite3.connect('db/ai_context.db')
	for surah, verse, content in conn.execute('select surah, verse, content from verse_analysis'):
		try:
			d = json.loads(content)
		except Exception:
			continue
		key = (surah, verse)
		context = _ws_re.sub(' ', d.get('verse_context') or '').strip()
		parts = [context]
		labeled = []
		for wm in d.get('word_meanings') or []:
			if not isinstance(wm, dict):
				continue
			word = wm.get('word') or ''
			classical = wm.get('classical_meaning') or ''
			here = wm.get('meaning_here') or ''
			usage = wm.get('notable_usage') or ''
			parts.extend([word, classical, here, usage])
			labeled.append(
				f'Word: {word} Classical meaning: {classical} '
				f'Meaning here: {here} Notable usage: {usage}'
			)
		ai[key] = _ws_re.sub(' ', _url_re.sub(' ', ' '.join(parts))).strip()
		contexts[key] = context
		word_meanings[key] = _ws_re.sub(' ', _url_re.sub(' ', ' '.join(labeled))).strip()
	conn.close()
	return ai, contexts, word_meanings


def load_rows():
	import pandas as pd

	# Arabic verses
	conn = sqlite3.connect('db/quran.db')
	arabic = {(s, a): t for s, a, t in conn.execute('select sura, ayah, text from verses')}
	conn.close()

	# English translation (Saheeh International)
	conn = sqlite3.connect('db/en_quran.db')
	translation = {(s, a): t for s, a, t in conn.execute('select sura, ayah, text from verses')}
	conn.close()

	# Tafsir Ibn Kathir (English). A few verses have no entry; they index as ''.
	conn = sqlite3.connect('db/en_kathir.db')
	en_tafsir = {(s, a): strip_markup(t) for s, a, t in
	              conn.execute('select surah, ayah, tafsir_text from tafsir_kathir')}
	conn.close()

	# Tafsir Abu Bakr Zakaria (Bengali)
	conn = sqlite3.connect('db/bn_zakaria.db')
	bn_tafsir = {(s, a): strip_markup(t) for s, a, t in
	              conn.execute('select sura, ayah, text from verses')}
	conn.close()

		# AI-generated verse context and word meanings share one source table.
	ai, contexts, word_meanings = load_ai_fields()

	# Surah display names: "N. Name (...)" -> "Name (...)"
	stat = pd.read_json('db/quran_stat.json')
	surah_names = {}
	for _, row in stat.iterrows():
		m = re.match(r'^\s*(\d+)\.\s*(.*)$', str(row['Surah']))
		if m:
			surah_names[int(m.group(1))] = m.group(2).strip()
		else:
			surah_names[int(row['Surah'])] = str(row['Surah'])

	verses = sorted(arabic)
	rows = []
	for surah, verse in verses:
		key = (surah, verse)
		rows.append({
			'surah': surah,
			'verse': verse,
			'ar_raw': (arabic.get(key) or '').strip(),
			'en': (translation.get(key) or '').strip(),
			'en_tafsir': en_tafsir.get(key, ''),
			'bn_tafsir': bn_tafsir.get(key, ''),
			'ai': ai.get(key, ''),
			'verse_context': contexts.get(key, ''),
			'word_meanings': word_meanings.get(key, ''),
			'surah_name': surah_names.get(surah, ''),
		})
	return rows


def add_english_index(conn):
	"""Add the optional translation index atomically, including on existing installs."""
	conn.execute('BEGIN IMMEDIATE')
	try:
		if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='english_stem'").fetchone():
			conn.execute("CREATE VIRTUAL TABLE english_stem USING fts5(en_norm, tokenize='porter unicode61')")
			conn.execute("INSERT INTO english_stem(rowid, en_norm) SELECT rowid, en_norm FROM docs")
		conn.commit()
	except Exception:
		conn.rollback()
		raise


def build():
	started = time.time()
	print('Reading local sources...')
	rows = load_rows()
	print(f'  {len(rows)} verses loaded in {time.time() - started:.1f}s')

	print(f'Writing {DB_OUT} ...')
	if os.path.exists(DB_OUT):
		os.remove(DB_OUT)
	conn = sqlite3.connect(DB_OUT)
	conn.execute("""
		CREATE VIRTUAL TABLE docs USING fts5(
			ar_norm, en_norm, ai_norm, en_tafsir_norm, bn_tafsir_norm, surah_name,
			surah UNINDEXED, verse UNINDEXED,
			ar_orig UNINDEXED, en UNINDEXED, ai UNINDEXED, en_tafsir UNINDEXED, bn_tafsir UNINDEXED,
			tokenize = 'unicode61 remove_diacritics 2'
		)
	""")
	# The trigram tokenizer (FTS5 substring search) requires SQLite >= 3.34.
	# Older builds (e.g. PythonAnywhere's libsqlite3) skip it; everything else
	# still works, and the search just loses the zero-hit substring fallback.
	try:
		conn.execute("""
			CREATE VIRTUAL TABLE docs_trgm USING fts5(
				ar_norm, en_norm,
				surah UNINDEXED, verse UNINDEXED,
				tokenize = 'trigram'
			)
		""")
		trgm_ok = True
	except sqlite3.OperationalError:
		trgm_ok = False
		print('note: FTS5 trigram tokenizer unavailable (needs SQLite >= 3.34) '
		      '- substring fallback disabled')
	vocab = Counter()
	for r in rows:
		ar_norm, _ = searchnorm.normalize(r['ar_raw'])
		en_norm, _ = searchnorm.normalize(r['en'])
		ai_norm, _ = searchnorm.normalize(r['ai'])
		en_tafsir_norm, _ = searchnorm.normalize(r['en_tafsir'])
		bn_tafsir_norm, _ = searchnorm.normalize(r['bn_tafsir'])
		r['ar_norm'] = ar_norm
		conn.execute(
			'INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
			(ar_norm, en_norm, ai_norm, en_tafsir_norm, bn_tafsir_norm, r['surah_name'],
			 r['surah'], r['verse'],
			 r['ar_raw'], r['en'], r['ai'], r['en_tafsir'], r['bn_tafsir']))
		if trgm_ok:
			conn.execute('INSERT INTO docs_trgm VALUES (?,?,?,?)',
			             (ar_norm, en_norm, r['surah'], r['verse']))
		for tok in ar_norm.split():
			if len(tok) >= 2:
				vocab[tok] += 1
		for tok in en_norm.split():
			if len(tok) >= 3:
				vocab[tok] += 1
		for tok in ai_norm.split():
			if len(tok) >= 3:
				vocab[tok] += 1
	conn.commit()

	add_english_index(conn)
	print('Building typo vocabulary ...')
	# Arabic has a small closed vocabulary; keep it all. English is capped by
	# frequency so the pickle stays small and BK-tree build stays fast.
	ar_tokens = {t: f for t, f in vocab.items() if any('\u0600' <= c <= '\u06ff' for c in t)}
	en_tokens = {t: f for t, f in vocab.items()
	              if not any('\u0600' <= c <= '\u06ff' for c in t) and f >= 5}
	en_tokens = dict(sorted(en_tokens.items(), key=lambda kv: -kv[1])[:150000])
	vtbl = {**ar_tokens, **en_tokens}
	with open(VOCAB_OUT, 'wb') as fh:
		pickle.dump(vtbl, fh, protocol=pickle.HIGHEST_PROTOCOL)

	conn.execute('INSERT INTO docs(docs) VALUES (\'optimize\')')
	if trgm_ok:
		conn.execute("INSERT INTO docs_trgm(docs_trgm) VALUES ('optimize')")
	conn.commit()
	size_mb = os.path.getsize(DB_OUT) / 1e6
	conn.close()
	print(f'done in {time.time() - started:.1f}s: {len(rows)} docs, '
	      f'{len(vtbl)} vocab tokens, {size_mb:.1f} MB index')


if __name__ == '__main__':
	import argparse
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--add-english-index', action='store_true',
	                    help='upgrade an existing search index in place')
	parser.add_argument('--add-root-index', action='store_true',
	                    help='add the annotated Arabic root index to an existing search index')
	args = parser.parse_args()
	if args.add_english_index and args.add_root_index:
		parser.error('choose one index upgrade at a time')
	if args.add_root_index:
		import searchtool
		with sqlite3.connect('file:db/search.db?mode=rw', uri=True, timeout=60) as conn:
			conn.row_factory = sqlite3.Row
			searchtool._ensure_root_index(conn)
	elif args.add_english_index:
		with sqlite3.connect('file:db/search.db?mode=rw', uri=True) as conn:
			add_english_index(conn)
	else:
		build()
