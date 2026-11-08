import pandas as pd
import os
from werkzeug.exceptions import abort
import sqlite3
from flask import Markup
import pickle
import re
import json
import copy
import time
import threading
import urllib.request
import unicodedata
from functools import lru_cache
from difflib import SequenceMatcher
from html import escape

from utils import json_to_html

pos_tags = {}
with open('db/pos_tags_dict.txt') as f:
	pos_tags = eval(f.read())

roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV']

roman_number = {str(i): j for i, j in  zip(range(1, 16), roman)}
roman_number[''] = ''

curr_surah = ''

@lru_cache(maxsize=1)
def quran_stat():
	# Read-only; shared by validate(), p_getSurahInfo() and the nav API.
	return pd.read_json('db/quran_stat.json')

def get_db_connection(db_name):
	conn = sqlite3.connect(db_name)
	conn.row_factory = sqlite3.Row
	return conn

# db/quran.db and db/en_quran.db are FTS3 virtual tables, so a
# `where sura = ? and ayah = ?` lookup scans the whole index (a few hundred
# ms on a slow disk). Both tables are immutable, so load them once and answer
# every later request from memory (about 6,236 rows / 1.2 MB each).
_text_mem = {'ar': None, 'en': None}
_text_lock = threading.Lock()


def _load_text_table(db_name, which):
	with _text_lock:
		if _text_mem[which] is not None:
			return _text_mem[which]
		conn = get_db_connection(db_name)
		rows = conn.execute('select sura, ayah, text from verses').fetchall()
		conn.close()
		_text_mem[which] = {(r['sura'], r['ayah']): r['text'] for r in rows}
		return _text_mem[which]


def _quran_text():
	return _load_text_table('db/quran.db', 'ar')


def _quran_translation():
	return _load_text_table('db/en_quran.db', 'en')


def get_ayah(surah, verse):
	return _quran_text().get((surah, verse), '')

# ---------------------------------------------------------------------------
# Tajweed (color-coded) ayah text.
#
# The Al Quran Cloud "quran-tajweed" edition wraps tajweed-rule segments as
#   [rule[:id][segment]
# e.g. "[h:9421[ٱ]" and "[n[ۥ]".  Rule letters map to the official tajweed
# colours documented at alquran.cloud/tajweed-guide; see TAJWEED_RULES.
# Rendering happens server-side into <span class="tj tj-<rule>">…</span>, and
# the colours live in static/css/style.css. To keep page loads snappy even
# when api.alquran.cloud is slow or down, requests are short-timeout, failures
# open a short cooldown (verbatim plain ayah is used meanwhile), and successes
# are lru_cached forever.

TAJWEED_RULES = {
	'h': 'ham_wasl',       # AAAAAA Hamzat ul Wasl
	's': 'silent',         # AAAAAA Silent
	'l': 'laam_shamsiyah', # AAAAAA Laam Shamsiyyah
	'n': 'madda_normal',   # 537FFF Madda Normal
	'p': 'madda_permissible',  # 4050FF Madda Permissible
	'm': 'madda_necessary',    # 000EBC Madda Necessary
	'q': 'qalaqah',        # DD0008 Qalqalah
	'o': 'madda_obligatory',   # 2144C1 Madda Obligatory
	'c': 'ikhafa_shafawi',     # D500B7 Ikhafa Shafawi
	'f': 'ikhafa',         # 9400A8 Ikhafa
	'w': 'idgham_shafawi',     # 58B800 Idgham Shafawi
	'i': 'iqlab',          # 26BFFD Iqlab
	'a': 'idgham_ghunnah',     # 169777 Idgham with Ghunnah
	'u': 'idgham_without_ghunnah',  # 169200 Idgham without Ghunnah
	'd': 'idgham_mutajanisayn',     # A1A1A1 Idgham Mutajanisayn
	'b': 'idgham_mutaqaribayn',     # A1A1A1 Idgham Mutaqaribayn
	'g': 'ghunnah',        # FF7E1E Ghunnah
}

tatweed_open_re = re.compile(r'\[([a-z])(?::\d+)?\[')

# Mushaf ornament glyphs (end of ayah, rub el hizb, kaaba) — part of the
# mushaf layout, not the verse words; skipped when clustering.
TAJWEED_IGN_GLYPHS = frozenset({'\u06DD', '\u06DE', '\u06E9'})  # ۝ ۞ ۩


def _tajweed_clusters(text):
	"""Cluster text into grapheme clusters over ayah characters.

	A cluster is a base letter plus any contiguous combining marks (Unicode
	category Mn). Cluster boundaries are what differ between the local DB
	text and the tajweed edition's own text (tatweel joiners, sukun vs
	rounded-zero variants ...), so clustering is the level at which the two
	editions can be aligned. Colour spans live on cluster indices, which
	maps cleanly onto the local glyphs.

	Returns a list of dicts {start, end, base, marks} (start/end are char
	positions in `text`).
	"""
	clusters = []
	gap = True
	for idx, ch in enumerate(text):
		if ch.isspace() or ch in TAJWEED_IGN_GLYPHS:
			gap = True
			continue
		mark = unicodedata.category(ch) == 'Mn'
		if mark and not gap and clusters:
			# mark attaches to the previous (contiguous) cluster
			clusters[-1]['end'] = idx + 1
			clusters[-1]['marks'] += 1
			continue
		clusters.append({'start': idx, 'end': idx + 1,
		                 'base': None if mark else ch,
		                 'marks': 1 if mark else 0})
		gap = False
	return clusters


def _cluster_key(cl):
	return (cl['base'], cl['marks'])


def _scan_tajweed_markup(markup):
	"""Walk the tajweed markup once with a stack of open markers.

	Returns (clusters, spans) where clusters are the markup edition's own
	grapheme clusters (keys only) and spans are dicts {rule,start,end} over
	cluster indices; a marker opened midspace of a cluster colors the whole
	cluster (inner-cluster marks attach). None on malformed markup.
	"""
	clusters = []
	spans = []
	active = []
	gap = True
	i = 0
	n = len(markup)
	while i < n:
		m = tatweed_open_re.match(markup, i)
		if m:
			sp = {'rule': m.group(1), 'start': len(clusters), 'end': None, 'mid': False}
			spans.append(sp)
			active.append(sp)
			i = m.end()
			continue
		ch = markup[i]
		if ch == ']':
			if not active:
				return None
			sp = active.pop()
			ci = len(clusters)
			if sp.get('mid') and clusters:
				sp['start'] -= 1          # opened inside the current cluster
			if sp['end'] is None:
				sp['end'] = ci
			i += 1
			continue
		if ch.isspace() or ch in TAJWEED_IGN_GLYPHS:
			gap = True
			i += 1
			continue
		mark = unicodedata.category(ch) == 'Mn'
		if mark and not gap and clusters:
			# extending the previous cluster: adjust spans that opened at
			# exactly the next (not yet created) cluster index
			ci = len(clusters)
			for sp in active:
				if sp['start'] == ci and not sp.get('mid'):
					sp['mid'] = True
			clusters[-1]['marks'] += 1
			i += 1
			continue
		clusters.append({'base': None if mark else ch,
		                 'marks': 1 if mark else 0})
		gap = False
		i += 1
	if active:
		return None
	for sp in spans:
		if sp['end'] is None:
			return None
	return clusters, spans


def _align_clusters(mkeys, lkeys):
	"""Map each markup cluster index to a local cluster index (identity when
	both cluster streams match; difflib alignment absorbs mark variants)."""
	if mkeys == lkeys:
		return list(range(len(lkeys)))
	sm = SequenceMatcher(None, mkeys, lkeys, autojunk=False)
	lmap = []
	for op, m1, m2, l1, l2 in sm.get_opcodes():
		if op == 'equal':
			for k in range(m2 - m1):
				lmap.append(l1 + k)
		elif op == 'delete':
			for k in range(m2 - m1):
				lmap.append(l2)
		elif op == 'replace':
			nn = min(m2 - m1, l2 - l1)
			for k in range(m2 - m1):
				lmap.append(l2 if k >= nn else l1 + k)
		# 'insert' maps no markup index
	return lmap


def _render_tajweed(local_text, char_spans):
	"""Wrap local_text characters with tajweed <span> runs.

	char_spans: ordered [(rule, start_char, end_char)] over local_text, with
	nesting only (a span fully inside its predecessor). Returns HTML or None
	if the spans cannot be nested cleanly.
	"""
	out = []
	active = []
	pi = 0
	for idx, ch in enumerate(local_text):
		while active and active[-1][2] == idx:
			out.append('</span>')
			active.pop()
		while pi < len(char_spans) and char_spans[pi][1] == idx:
			rule, s, e = char_spans[pi]
			if active and e > active[-1][2]:
				# partially overlapping; clamp inside the surrounding span
				e = min(e, active[-1][2])
				if e <= s:
					pi += 1
					continue
			out.append('<span class="tj tj-{0}">'.format(rule))
			active.append((rule, s, e))
			pi += 1
		out.append(escape(ch))
	while active:
		out.append('</span>')
		active.pop()
	if pi != len(char_spans):
		return None
	return ''.join(out)


@lru_cache(maxsize=6236)
def _fetch_tajweed_ayah(surah, verse):
	url = f'https://api.alquran.cloud/v1/ayah/{surah}:{verse}/quran-tajweed'
	req = urllib.request.Request(url, headers={'User-Agent': 'Aayatun/1.0'})
	with urllib.request.urlopen(req, timeout=4) as r:
		data = json.loads(r.read().decode('utf-8'))
	return data.get('data', {}).get('text')


TAJWEED_CACHE_DB = 'db/tajweed_cache.db'
tajweed_cooldown = {'until': 0.0}
# In-memory copy of the sqlite cache: populated once per process from
# db/tajweed_cache.db, kept fresh on new fetches. Reads never touch disk,
# which keeps the D:/ network-layout sqlite latency out of page loads.
tajweed_mem = {}


def _tajweed_cache_conn():
	conn = sqlite3.connect(TAJWEED_CACHE_DB)
	conn.execute(
		'create table if not exists taj '
		'(sura integer, ayah integer, markup text, primary key (sura, ayah))')
	return conn


def _tajweed_load_cache():
	if tajweed_mem:
		return
	try:
		conn = _tajweed_cache_conn()
		for s, v, m in conn.execute('select sura, ayah, markup from taj'):
			tajweed_mem[(s, v)] = m
		conn.close()
	except Exception:
		pass


def get_tajweed_ayah(surah, verse):
	"""Return the tajweed-marked ayah text from Al Quran Cloud, or None.

	Successes are stored in a local sqlite cache (db/tajweed_cache.db), so a
	verse never needs the network twice: phone data flakiness can delay a
	colouring the first time, but cannot lose it once fetched.
	"""
	key = (surah, verse)
	_tajweed_load_cache()
	if key in tajweed_mem:
		return tajweed_mem[key]
	if time.time() < tajweed_cooldown['until']:
		return None
	try:
		markup = _fetch_tajweed_ayah(surah, verse)
	except Exception:
		# Brief pause before retrying the API so one hiccup does not hammer
		# it; anything already cached is unaffected.
		tajweed_cooldown['until'] = time.time() + 15
		return None
	if not markup:
		return None
	tajweed_mem[key] = markup
	try:
		conn = _tajweed_cache_conn()
		conn.execute('insert or replace into taj (sura, ayah, markup) values (?, ?, ?)',
		             (surah, verse, markup))
		conn.commit()
		conn.close()
	except Exception:
		pass
	return markup


# Surahs already warmed in this process (daemon threads preheat the rest of
# the surah's verses so later page loads render colours instantly, even
# offline once warmed).
_tajweed_warmed = set()
_tajweed_warm_lock = threading.Lock()


def _preheat_tajweed_surah(surah, count):
	try:
		conn = _tajweed_cache_conn()
		done = {r[0] for r in conn.execute(
			'select ayah from taj where sura = ?', (surah,))}
		conn.close()
		for v in range(1, count + 1):
			if v in done:
				continue
			if time.time() < tajweed_cooldown['until']:
				return
			try:
				get_tajweed_ayah(surah, v)
			except Exception:
				return
			time.sleep(0.25)
	except Exception:
		pass


def warm_tajweed_surah(surah, count):
	"""Kick off a background daemon thread to preheat the surah's verses."""
	with _tajweed_warm_lock:
		if surah in _tajweed_warmed:
			return
		_tajweed_warmed.add(surah)
	thread = threading.Thread(target=_preheat_tajweed_surah, args=(surah, count), daemon=True)
	thread.start()


# ---------------------------------------------------------------------------
# Quran.com mushaf (QCF TajweedV4) rendering data
#
# quran.com colors its mushaf with per-page COLRv1 fonts whose glyphs are
# whole pre-formed words (Arabic Presentation Forms-B codepoints — their
# per-word "code_v2"). All tajweed colours live INSIDE the font (per theme
# palettes), including madda annotations the markup edition never carries,
# so rendering that font is exactly quran.com's look. The verse page keeps
# the markup-based <span> version as the server-side default and swaps to
# this font at runtime when its woff2 loads.
QCF_CACHE_DB = 'db/qcf_cache.db'
QCF_VERSES_JSON = 'db/qcf_verses.json'
QCF_FONT_URL = 'https://quran.com/fonts/quran/hafs/v4/colrv1/woff2/p{page}.woff2'
qcf_cooldown = {'until': 0.0}
qcf_mem = {}        # (surah, verse) -> (mushaf_page, code_v2)
qcf_page_index = {} # mushaf page -> ((surah, verse), ...) in reading order
qcf_font_mem = {}   # page -> font bytes
_qcf_load_lock = threading.Lock()


def _qcf_cache_conn():
	conn = sqlite3.connect(QCF_CACHE_DB)
	conn.execute(
		'create table if not exists qcf '
		'(sura integer, ayah integer, page integer, codev2 text, '
		'primary key (sura, ayah))')
	return conn


def _build_qcf_page_index():
	idx = {}
	for (s, v), (p, _c) in qcf_mem.items():
		idx.setdefault(p, []).append((s, v))
	qcf_page_index.clear()
	for p, rows in idx.items():
		qcf_page_index[p] = tuple(sorted(rows))


def _qcf_load_cache():
	# db/qcf_verses.json ships the page + code_v2 of all 6,236 verses, so the
	# carousel never snapshots a half-filled network cache again (that was the
	# "tajweed font stops working after a few swipes" bug). The sqlite cache
	# is only a fallback for an install without the seed file.
	if qcf_mem:
		return
	with _qcf_load_lock:
		if qcf_mem:
			return
		try:
			with open(QCF_VERSES_JSON, encoding='utf-8') as f:
				for s, v, p, c in json.load(f)['verses']:
					qcf_mem[(s, v)] = (p, c)
		except Exception:
			pass
		if not qcf_mem:
			try:
				conn = _qcf_cache_conn()
				for s, v, p, c in conn.execute('select sura, ayah, page, codev2 from qcf'):
					qcf_mem[(s, v)] = (p, c)
				conn.close()
			except Exception:
				pass
		_build_qcf_page_index()


def get_qcf_ayah(surah, verse):
	"""Return (mushaf_page, code_v2_text) for a verse from quran.com, or None.

	Cached in db/qcf_cache.db (+ in-process dict) the same way as the tajweed
	markup, so a verse never needs the network twice."""
	key = (surah, verse)
	_qcf_load_cache()
	if key in qcf_mem:
		return qcf_mem[key]
	if time.time() < qcf_cooldown['until']:
		return None
	url = (f'https://api.quran.com/api/v4/verses/by_key/{surah}:{verse}'
	       '?fields=page_number&words=true&word_fields=code_v2&translations=null')
	req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
	try:
		with urllib.request.urlopen(req, timeout=6) as r:
			data = json.loads(r.read().decode('utf-8'))
	except Exception:
		# brief cooldown so one hiccup does not hammer the API
		qcf_cooldown['until'] = time.time() + 15
		return None
	try:
		verse_ = data.get('verse', {})
		page = int(verse_.get('page_number') or 0)
		words = [w.get('code_v2') for w in verse_.get('words', []) if w.get('code_v2')]
		codev2 = ' '.join(words).strip()
		if not (1 <= page <= 604) or not codev2:
			raise ValueError('empty qcf payload')
	except Exception:
		return None
	res = (page, codev2)
	qcf_mem[key] = res
	try:
		conn = _qcf_cache_conn()
		conn.execute('insert or replace into qcf (sura, ayah, page, codev2) '
		             'values (?, ?, ?, ?)', (surah, verse, page, codev2))
		conn.commit()
		conn.close()
	except Exception:
		pass
	return res


def get_qcf_font(page):
	"""Return the page's QCF colrv1 font bytes, downloading once to db/fonts."""
	if page in qcf_font_mem:
		return qcf_font_mem[page]
	path = f'db/fonts/v4-p{page}.woff2'
	try:
		with open(path, 'rb') as f:
			b = f.read()
		qcf_font_mem[page] = b
		return b
	except OSError:
		pass
	try:
		req = urllib.request.Request(QCF_FONT_URL.format(page=page),
		                             headers={'User-Agent': 'Mozilla/5.0'})
		with urllib.request.urlopen(req, timeout=20) as r:
			b = r.read()
		os.makedirs('db/fonts', exist_ok=True)
		with open(path, 'wb') as f:
			f.write(b)
		qcf_font_mem[page] = b
		return b
	except Exception:
		return None


_qcf_warmed = set()
_qcf_warm_lock = threading.Lock()


def _preheat_qcf_surah(surah, count):
	for v in range(1, count + 1):
		if time.time() < qcf_cooldown['until']:
			return
		try:
			get_qcf_ayah(surah, v)
		except Exception:
			return
		time.sleep(0.25)


def warm_qcf_surah(surah, count):
	"""Preheat quran.com's per-verse mushaf data (page + code_v2) in background.

	The shipped seed already covers every verse, so this is a no-op unless the
	seed file is missing and the sqlite cache is incomplete."""
	_qcf_load_cache()
	if all((surah, v) in qcf_mem for v in range(1, count + 1)):
		return
	with _qcf_warm_lock:
		if surah in _qcf_warmed:
			return
		_qcf_warmed.add(surah)
	thread = threading.Thread(target=_preheat_qcf_surah, args=(surah, count), daemon=True)
	thread.start()


def tajweed_to_html(local_text, markup):
	"""Return the local ayah text coloured per the tajweed edition's rules.

	Glyphs always come from `local_text` (consistent everywhere in the app);
	only the cluster runs between cluster boundaries are wrapped with
	`<span class="tj tj-<rule>">`. When the markup cannot be applied cleanly,
	this returns None and the caller falls back to the plain ayah.
	"""
	# The tajweed edition inserts tatweel (U+0640) joiners and ZWJ (U+200C)
	# that the rest of the app's text does not carry; ignore them for matching.
	markup = markup.replace('\u0640', '').replace('\u200c', '')
	res = _scan_tajweed_markup(markup) if markup else None
	if res is None:
		return None
	mclusters, spans = res
	lclusters = _tajweed_clusters(local_text)
	lmap = _align_clusters([_cluster_key(c) for c in mclusters],
	                       [_cluster_key(c) for c in lclusters])
	if len(lmap) < len(mclusters):
		return None
	char_spans = []
	for sp in spans:
		if sp['end'] <= sp['start']:
			continue
		s = lmap[sp['start']] if sp['start'] < len(lmap) else len(lclusters)
		e = lmap[sp['end'] - 1] + 1 if sp['end'] - 1 < len(lmap) else len(lclusters)
		if s >= len(lclusters) or e <= s:
			continue
		char_spans.append((sp['rule'], lclusters[s]['start'], lclusters[e - 1]['end']))
	# The King Fahd colored mushaf fonts (quran.com's tajweed mode) also
	# colour the superscript dagger-alef maddas [U+0670] — عَلَىٰ, هَٰذَا,
	# كِتَٰب … — which the markup edition simply never annotates, so those
	# spots stay plain here. Annotate them ourselves: colour only the
	# combining marks (the base letter stays black like quran.com's font),
	# and skip clusters the markup already covers or that carry a maddah
	# [U+0653] classified by the markup itself.
	for cl in lclusters:
		anchor = cl['start'] + (1 if cl['base'] is not None else 0)
		if anchor >= cl['end']:
			continue                       # cluster has no marks to colour
		seg = local_text[anchor:cl['end']]
		if '\u0670' not in seg or '\u0653' in seg:
			continue
		if any(s < cl['end'] and cl['start'] < e for _, s, e in char_spans):
			continue                       # already inside a markup span
		char_spans.append(('n', anchor, cl['end']))
	char_spans.sort(key=lambda t: (t[1], -t[2]))
	return _render_tajweed(local_text, char_spans)


def get_ayah_tajweed(surah, verse):
	"""Colour-coded ayah HTML for the local DB text, or None to fall back to plain."""
	markup = get_tajweed_ayah(surah, verse)
	if not markup:
		return None
	try:
		return tajweed_to_html(get_ayah(surah, verse), markup)
	except Exception:
		return None

def get_translation(surah, verse):
	return _quran_translation().get((surah, verse), '')

def get_en_kathir(surah, verse):
	conn = get_db_connection('db/en_kathir.db')
	translation = conn.execute(f'select tafsir_text from tafsir_kathir where surah = {surah} and ayah = {verse}').fetchone()
	conn.close()
	if translation is None: return ''
	return translation['tafsir_text']

def get_bn_zakaria(surah, verse):
	conn = get_db_connection('db/bn_zakaria.db')
	translation = conn.execute(f'select text from verses where sura = {surah} and ayah = {verse}').fetchone()
	conn.close()
	if translation is None: return ''
	return translation['text']

def getAnnot(x):
	ret = []
	for i in range(1, 6):
		if x[f'ar{i}'] != '':
			ret.append((x[f'ar{i}'], x[f'pos{i}']))
	return ret

def getVerbTable(x):
	ret = []
	if (x['root'] != ''):
		ret.append(('Perfect', x['perfect']))
		ret.append(('Imperfect', x['imperfect']))
		ret.append(('Imperative', x['imperative']))
		ret.append(('Active Participle', x['active_participle']))
		ret.append(('Passive Participle', x['passive_participle']))
		ret.append(('Verbal Noun', x['verbal_noun']))
	return ret

def get_morph(surah, verse):
	conn = get_db_connection('db/corpus.db')

	df = pd.read_sql(f"SELECT * from corpus left join verbs_with_six_forms on (corpus.root_ar = verbs_with_six_forms.root) where surah = {surah} and ayah = {verse}", con=conn)
	df = df.drop_duplicates(['surah', 'ayah', 'word'])
	conn.close()
	conn = get_db_connection('db/words.db')
	df2 = pd.read_sql(f"SELECT word, en from allwords where sura = {surah} and ayah = {verse}", con=conn)
	df = df.merge(df2, how='inner', on='word')
	# df = df[df[['ayah', 'word']].shift() != df[['ayah', 'word']]].reset_index()
	conn.close()
	# conn = get_db_connection('db/corpus.db')
	# df = pd.read_sql(f"SELECT * from corpus left join verbs_with_six_forms on (corpus.root_ar = verbs_with_six_forms.root) where surah = {surah} and ayah = {verse}", con=conn)
	# conn.close()
	df = df.fillna('')
	for m in range(1, 6):
		df[f'pos{m}'] = df[f'pos{m}'].map(pos_tags)

	ret = [
	{
		'word' : ''.join([r[f'ar{p}'] for p in range(1, 6)]),
		'lemma' : r['lemma'],
		'root' : r['root_ar'],
		'meaning' : r['en'],
		'annot' : getAnnot(r),
		'verb_form' : getVerbTable(r),
		'verb_type' : roman_number[r['verf_form']]
	}

	for i, r in df.iterrows()]
	# db_data = conn.execute().fetchall()

	return ret

def validate(surah, verse):
	global curr_surah
	x = quran_stat()
	if surah > 114 or surah < 1:
		return False
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	if (verse < 1) or verse > int(x.loc[surah]['Verses']):
		return False
	return True



def get_combined_df(root):
	conn = get_db_connection('db/corpus.db')
	df = pd.read_sql(f"SELECT surah, ayah, word, root_ar, IFNULL(ar1, '') || IFNULL(ar2, '') || IFNULL(ar3, '') || IFNULL(ar4, '') || IFNULL(ar5, '') as ar from corpus where root_ar='{root}'", con=conn)
	df = df.drop_duplicates(['surah', 'ayah', 'word'])
	# conn.close()
	conn = get_db_connection('db/words.db')
	df2 = pd.read_sql(f"SELECT sura as surah, ayah, word, en from allwords", con=conn)
	df = df.merge(df2, how='inner', on=['surah', 'ayah', 'word'])
	df['en'] = df['en'].str.lower()
	# df = df[df[['ayah', 'word']].shift() != df[['ayah', 'word']]].reset_index()
	conn.close()
	return df

def get_related_meanings(root, surah, verse):
	if root == '-': return []
	df = get_combined_df(root).sort_values('en')

	# ['surah', 'ayah', 'word', 'en']
	df = df.query(f'surah != {surah} and ayah != {verse}').drop_duplicates(subset=['en'])
	return [(r['ar'], r['en'], r['surah'], r['ayah']) for i, r in df.iterrows()]

def get_word_for_word_meaning(surah, verse):
	conn = get_db_connection('db/corpus.db')
	df = pd.read_sql(f"SELECT surah, ayah, word, root_ar, IFNULL(ar1, '') || IFNULL(ar2, '') || IFNULL(ar3, '') || IFNULL(ar4, '') || IFNULL(ar5, '') as ar from corpus where surah={surah} and ayah={verse}", con=conn)
	
	# conn.close()
	conn = get_db_connection('db/words.db')
	df2 = pd.read_sql(f"SELECT sura as surah, ayah, word, en from allwords where surah={surah} and ayah={verse}", con=conn)
	df = df.merge(df2, how='inner', on=['surah', 'ayah', 'word'])
	# df['en'] = df['en'].str.lower()
	# df = df[df[['ayah', 'word']].shift() != df[['ayah', 'word']]].reset_index()
	# df = df.sort_values('en')
	df = df.drop_duplicates(['surah', 'ayah', 'word'])
	conn.close()
	df['root_ar'].replace({'': '-'}, inplace=True)
	return [{
	'0': r['ar'], 
	'1': r['en'], 
	'2': r['root_ar'] if r['root_ar'] == '-' else (u' ').join(list(r['root_ar'])), 
	'3': get_related_meanings(r['root_ar'], surah, verse), 
	'4': i}
	for i, r in df.iterrows()]

def get_word_definions(surah, verse):
	x = pd.read_json('db/all_word_def.json')
	x = x.loc[x['arabic'].shift() != x['arabic']].query(f'surah == {surah} and verse == {verse}')
	# y = [{'0': a, '1': b, '2': c, '3': get_related_meanings(c.replace(' ', ''), surah, verse), '4': d} for a, b, c, d in zip(x['arabic'].fillna('-'), x['meaning'].fillna('-'), x['arabic_root'].fillna('-'), range(len(x)))]
	y = get_word_for_word_meaning(surah, verse)
	x = x.query('key == key')
	z = [(a, b, c, Markup(d.replace('$lb$', '<br>'))) for a, b, c, d in zip(x['arabic'].fillna('-'), x['meaning'].fillna('-'), x['arabic_root'].fillna('-'), x['definitions'].fillna('-'))]
	return y, z

def getSurahInfo(surah, verse):
	if validate(surah, verse) == False:
		abort(404)
	z = []
	with open('db/quran_index.txt') as f:
		z = eval(f.read())
	pos = z.index((surah, verse))
	a, b = get_word_definions(surah, verse)

	return {
	'surah_name' : curr_surah,
	'surah': surah,
	'verse' : verse,
	'prev' : z[pos - 1],
	'next' : z[(pos + 1) % len(z)],
	'ayah' : get_ayah(surah, verse),
	'ayah_tajweed' : get_ayah_tajweed(surah, verse),
	'translation' : get_translation(surah, verse),
	'wordforword' : a,
	'definitions' : b,
	'morph' : get_morph(surah, verse),
	'en_kathir' : Markup(get_en_kathir(surah, verse).replace('\n', '<br>')),
	'bn_zakaria' : Markup(get_bn_zakaria(surah, verse).replace('\n', '<br>'))
	}

@lru_cache(maxsize=8)
def get_full_tranlation(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = quran_stat()
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	text = _quran_translation()
	count = int(x['Verses'].loc[int(surah)])
	rows = [text.get((surah, v), '') for v in range(1, count + 1)]
	return curr_surah, tuple(zip(range(1, len(rows) + 1), rows))


def get_full_en_tafsir(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = pd.read_json('db/quran_stat.json')
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	conn = get_db_connection('db/en_kathir.db')
	result = conn.execute(f'select tafsir_text from tafsir_kathir where surah = {surah}').fetchall()
	conn.close()

	x = [Markup(x['tafsir_text'].replace('\n', '<br>')) for x in result]
	return curr_surah, zip(list(range(1, len(x)+1)), x)

def get_full_bn_tafsir(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = pd.read_json('db/quran_stat.json')
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	conn = get_db_connection('db/bn_zakaria.db')
	result = conn.execute(f'select text from verses where sura = {surah}').fetchall()
	conn.close()

	x = [Markup(x['text'].replace('\n', '<br>')) for x in result]
	return curr_surah, zip(list(range(1, len(x)+1)), x)

@lru_cache(maxsize=8)
def get_full_arabic(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = quran_stat()
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	text = _quran_text()
	count = int(x['Verses'].loc[int(surah)])
	rows = [text.get((surah, v), '') for v in range(1, count + 1)]
	return curr_surah, tuple(zip(range(1, len(rows) + 1), rows))



class RootDefAdder:
	def __init__(self, details):
		self.sarf_db = pd.read_json('db/sarf.json')
		self.details = details;

	def get_root_def(self, root):
		x = self.sarf_db.query(f'Root == "{root}"')[["Baab", "Description", "Form"]]
		return [(j["Baab"], j["Form"], j["Description"].replace("/", " / ")) for i, j in x.iterrows()]

	def add_root_def(self, item):
		item['root_def'] = self.get_root_def(item['root'])
		return item

	def add_slash_in_definions(self, item):
		return (item[0], item[1], item[2], item[3].replace("/", " / "))
	
	def add_ai_explanation(self):
		# print('test')
		surah, verse = self.details['surah'], self.details['verse'] - 1
		try:
			# with open(f'/mnt/d/PROJECTS/aayatun_ai_content/output/{surah}_{verse}.json') as f:
			conn = get_db_connection('db/ai_context.db')
			result = conn.execute("SELECT content FROM verse_analysis WHERE surah=? AND verse=?", (surah, verse)).fetchone()
			conn.close()
			# print(str(result["content"]))
			x = eval(result["content"])
			self.details['ai_explanation'] = json_to_html(x)
		except Exception as e:
			print(e)
			self.details['ai_explanation'] = ''
			

	def update(self):
		for i in range(len(self.details['morph'])):
			self.details['morph'][i] = self.add_root_def(self.details['morph'][i])
		for i in range(len(self.details['definitions'])):
			self.details['definitions'][i] = self.add_slash_in_definions(self.details['definitions'][i])
		self.add_ai_explanation()
		return self.details

def get_verse_pickle(surah, verse):
    DB_FILE = 'db2/quran_metadata.db'
    conn = sqlite3.connect(DB_FILE)

    row = conn.execute(
        """
        SELECT data
        FROM verses
        WHERE surah = ? AND verse = ?
        """,
        (surah, verse),
    ).fetchone()

    conn.close()

    if row is None:
        raise KeyError(f"Verse {surah}:{verse} not found")

    return pickle.loads(row[0])

def p_getSurahInfo(surah, verse):
	if validate(surah, verse) == False:
		abort(404)
	# b = {}
	# with open(f'db2/{surah}_{verse}.pickle', 'rb') as handle:
	#     b = pickle.load(handle)
	b = get_verse_pickle(surah, verse)
	d = RootDefAdder(b).update()
	t = get_ayah_tajweed(surah, verse)
	d['ayah_tajweed'] = Markup(t) if t else None
	# Quran.com mushaf data (per-page colored font + pre-formed word
	# codepoints); the page ships the markup version as default and the
	# browser swaps to the font when its woff2 is reachable.
	qcf = get_qcf_ayah(surah, verse)
	d['qcf_page'] = qcf[0] if qcf else None
	d['ayah_codev2'] = Markup(qcf[1]) if qcf else None
	try:
		_vcount = int(quran_stat()['Verses'].loc[int(surah)])
		warm_tajweed_surah(int(surah), int(_vcount))
		warm_qcf_surah(int(surah), int(_vcount))
	except Exception:
		pass
	return d

# ---------------------------------------------------------------------------
# Verse navigation API.
#
# The page is still rendered server-side on first load. Next/prev then ask for
# this small "core" payload (and fetch accordion sections only when opened),
# so a nav does not ship the morphology/tafsir/AI blocks again.
VERSE_CORE_KEYS = ('surah_name', 'surah', 'verse', 'prev', 'next', 'ayah', 'translation')
VERSE_SECTIONS = ('ai', 'wfw', 'defs', 'morph', 'bn', 'en')

def get_verse_core(surah, verse):
	"""Small, fast per-verse payload for client-side navigation."""
	if not validate(surah, verse):
		abort(404)
	b = get_verse_pickle(surah, verse)
	d = {k: b[k] for k in VERSE_CORE_KEYS}
	t = get_ayah_tajweed(surah, verse)
	d['ayah_tajweed'] = t or ''
	qcf = get_qcf_ayah(surah, verse)
	d['qcf_page'] = qcf[0] if qcf else None
	d['ayah_codev2'] = qcf[1] if qcf else ''
	try:
		_vcount = int(quran_stat()['Verses'].loc[int(surah)])
		warm_tajweed_surah(int(surah), _vcount)
		warm_qcf_surah(int(surah), _vcount)
	except Exception:
		pass
	return d

def peek_qcf_ayah(surah, verse):
	"""(mushaf_page, code_v2) only if already cached locally.

	Like get_qcf_ayah() but never touches the network, so a whole-surah build
	can read 286 verses without waiting on quran.com. The background warmers
	fill the gaps for the next request."""
	_qcf_load_cache()
	return qcf_mem.get((surah, verse))

def get_surah_qcf(surah):
	"""((mushaf_page, code_v2), ...) for a whole surah, in verse order."""
	_qcf_load_cache()
	return tuple(qcf_mem.get((surah, v)) or (None, '')
	             for v in range(1, _surah_verse_count(surah) + 1))

@lru_cache(maxsize=8)
def get_mushaf_page(page):
	"""One Madani mushaf page as verse groups (surah boundaries included).

	Page membership comes from db/qcf_verses.json (quran.com's by_page
	endpoint, which is authoritative: some verses carry a stale per-verse
	page_number). A page can span up to three surahs; each group gets a
	banner/bismillah only when the page contains that surah's first verse.
	"""
	if not (1 <= page <= 604):
		abort(404)
	_qcf_load_cache()
	rows = qcf_page_index.get(page) or ()
	texts = {}
	groups = []
	for s, v in rows:
		q = qcf_mem.get((s, v))
		if not q:
			continue
		if s not in texts:
			name, arabic = get_full_arabic(s)
			_, translation = get_full_tranlation(s)
			texts[s] = {
				'name': name,
				'ar': [t for _, t in arabic],
				'tr': [t for _, t in translation],
			}
		t = texts[s]
		if not groups or groups[-1]['surah'] != s:
			groups.append({
				'surah': s,
				'name': t['name'],
				'start': v == 1,
				'bismillah': v == 1 and s not in (1, 9),
				'rows': [],
			})
		groups[-1]['rows'].append({
			'surah': s,
			'verse': v,
			'surah_name': t['name'],
			'arabic': t['ar'][v-1] if v-1 < len(t['ar']) else '',
			'translation': t['tr'][v-1] if v-1 < len(t['tr']) else '',
			'qcf_page': q[0] or page,
			'codev2': q[1],
			'start': v == 1,
			'bismillah': v == 1 and s not in (1, 9),
		})
	for g in groups:
		g['rows'] = tuple(g['rows'])
	return {
		'page': page,
		'prev': page - 1 if page > 1 else 604,
		'next': page + 1 if page < 604 else 1,
		'groups': tuple(groups),
		'surah_names': tuple(g['name'] for g in groups),
		'count': sum(len(g['rows']) for g in groups),
	}

# ---------------------------------------------------------------------------
# Mushaf line layout
#
# db/mushaf_lines.json is generated from zonetecde/mushaf-layout's QPC2 pages
# (one file per Madani page). Each page is a list of typed lines:
#   ['h', surah]              surah banner
#   ['b']                     basmala (U+FDFD in Amiri)
#   ['x', [[surah, verse, glyphs], ...]]
# Page membership and line breaks are the V2 (QPC2) ones, so they match the
# per-page fonts served by /font/v4/<page>.woff2. The file is loaded once into
# memory (about 560 KB) and reused by every /page/<n> request.
MUSHAF_LINES_JSON = 'db/mushaf_lines.json'
_mushaf_lines_mem = None
_mushaf_lines_lock = threading.Lock()


def _mushaf_fix_banners(pages):
	"""Move a next-surah banner to the page that surah actually starts on.

	The source layout puts the surah name as the LAST line of the page before
	the one its verses begin on (e.g. Abasa on page 584, whose basmala and
	80:1 are the top of 585). Read as-is that leaves a dangling banner under
	the previous page's last verse, so move it above the next page's basmala,
	which is also what the table view shows. Done on load, not in the JSON,
	so a regenerated file is corrected too.
	"""
	for n in range(1, 604):
		cur = pages.get(str(n))
		nxt = pages.get(str(n + 1))
		if not cur or not nxt or cur[-1][0] != 'h':
			continue
		surah = int(cur[-1][1])
		first = next((seg[0] for ln in nxt if ln[0] == 'x' for seg in ln[1]), None)
		if first is not None and int(first) == surah:
			nxt.insert(0, cur.pop())


def _mushaf_lines():
	global _mushaf_lines_mem
	if _mushaf_lines_mem is not None:
		return _mushaf_lines_mem
	with _mushaf_lines_lock:
		if _mushaf_lines_mem is None:
			with open(MUSHAF_LINES_JSON, encoding='utf-8') as f:
				pages = json.load(f)['pages']
			_mushaf_fix_banners(pages)
			_mushaf_lines_mem = pages
	return _mushaf_lines_mem


# Plain layout text ends each verse with its Arabic-Indic number; the normal
# font view shows it in parentheses (the QCF glyphs carry their own ornate
# marker). One match per verse, always at the end of a segment.
_AYAH_END = re.compile(r'([٠-٩]+)$')

# AI-written orientation for each printed Madani page, generated offline
# (see AGENTS.md). Static data, so a small query per page view is enough;
# pages without a row simply hide the overview accordion.
PAGE_OVERVIEWS_DB = 'db/page_overviews.db'


@lru_cache(maxsize=128)
def get_page_overview(page):
	if not (1 <= page <= 604) or not os.path.exists(PAGE_OVERVIEWS_DB):
		return None
	try:
		conn = get_db_connection(PAGE_OVERVIEWS_DB)
		row = conn.execute(
			'SELECT context, summary FROM page_overviews WHERE page = ?',
			(page,)).fetchone()
		conn.close()
	except sqlite3.Error:
		return None
	if not row or not row['context'] or not row['summary']:
		return None
	return {'context': row['context'], 'summary': row['summary']}

@lru_cache(maxsize=16)
def get_mushaf_lines(page):
	"""Typed layout lines for one Madani page (1-604).

	Returns a tuple of dicts: {'type': 'header', 'surah', 'name'},
	{'type': 'basmala'} or {'type': 'text', 'segments': (...)}, where each
	segment is {'surah', 'verse', 'glyphs', 'text'} in mushaf order. `glyphs`
	is the QPC2 code for the colored font; `text` is the same fragment in
	plain Uthmani Arabic for the normal-font fallback. Rendered by
	templates/mushaf_page.html's layout view.
	"""
	if not (1 <= page <= 604):
		abort(404)
	raw = _mushaf_lines().get(str(page))
	if not raw:
		return ()
	out = []
	for i, ln in enumerate(raw):
		if ln[0] == 'h':
			s = int(ln[1])
			out.append({'type': 'header', 'surah': s, 'name': get_full_arabic(s)[0]})
		elif ln[0] == 'b':
			out.append({'type': 'basmala'})
		else:
			# The only lines that may stay short in print are the last line
			# of a surah (next line is a banner) and the last line of the
			# page; every other line is justified to the column edge.
			endblock = i + 1 >= len(raw) or raw[i + 1][0] != 'x'
			out.append({
				'type': 'text',
				'endblock': endblock,
				'segments': tuple(
					{'surah': int(a), 'verse': int(b), 'glyphs': c,
					 'text': _AYAH_END.sub(r'(\1)', d)}
					for a, b, c, d in ln[1]
				),
			})
	return tuple(out)


def _surah_verse_count(surah):
	return int(quran_stat()['Verses'].loc[int(surah)])

@lru_cache(maxsize=1)
def surah_starts():
	"""Flat 0-based index of every surah's first verse (114 entries)."""
	x = quran_stat()
	starts = []
	total = 0
	for s in range(1, 115):
		starts.append(total)
		total += int(x['Verses'].loc[s])
	return tuple(starts)

def verse_index(surah, verse):
	"""0-based position of a verse in mushaf order (0 = 1:1, 6235 = 114:6)."""
	if not (1 <= surah <= 114):
		abort(404)
	if not (1 <= verse <= _surah_verse_count(surah)):
		abort(404)
	return surah_starts()[surah - 1] + verse - 1

@lru_cache(maxsize=1)
def get_page_bounds():
	"""Flat verse index of the first verse of each of the 604 mushaf pages.

	Page membership in db/qcf_verses.json is monotonic and contiguous over
	the canonical verse order, so 604 offsets are enough for the reading map
	to place every verse without shipping a 6,236-entry table. An unexpected
	layout returns () and the map drops its page layer."""
	_qcf_load_cache()
	bounds = []
	total = 0
	for page in range(1, 605):
		bounds.append(total)
		total += len(qcf_page_index.get(page) or ())
	if total != 6236:
		return ()
	return tuple(bounds)

# The text of every verse of a surah, for the swipe carousel: the client asks
# once and then moves between verses without any further round trip. Kept
# compact (arrays, no repeated keys) since Al-Baqarah alone is ~200 KB.
@lru_cache(maxsize=4)
def get_surah_core(surah):
	if surah < 1 or surah > 114:
		abort(404)
	name, arabic = get_full_arabic(surah)
	_, translation = get_full_tranlation(surah)
	ar = [t for _, t in arabic]
	tr = [t for _, t in translation]
	n = min(len(ar), len(tr))
	verses = []
	for i in range(n):
		q = peek_qcf_ayah(surah, i + 1) or (None, '')
		verses.append((ar[i], tr[i], q[0], q[1]))
	prev_ = ((surah - 1, _surah_verse_count(surah - 1)) if surah > 1
		else (114, _surah_verse_count(114)))
	next_ = ((surah + 1, 1) if surah < 114 else (1, 1))
	return {
		'surah': surah,
		'name': name,
		'count': n,
		'verses': tuple(verses),
		'prev': prev_,
		'next': next_,
	}

@lru_cache(maxsize=24)
def _verse_details_cached(surah, verse):
	return p_getSurahInfo(surah, verse)

def get_verse_details(surah, verse):
	"""(Deep-copied) full details, shared by the SSR page and section API."""
	return copy.deepcopy(_verse_details_cached(surah, verse))