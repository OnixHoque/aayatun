import pandas as pd
from werkzeug.exceptions import abort
import sqlite3
from flask import Markup
import pickle

pos_tags = {}
with open('db/pos_tags_dict.txt') as f:
	pos_tags = eval(f.read())

roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV']

roman_number = {str(i): j for i, j in  zip(range(1, 16), roman)}
roman_number[''] = ''

curr_surah = ''

def get_db_connection(db_name):
	conn = sqlite3.connect(db_name)
	conn.row_factory = sqlite3.Row
	return conn

def get_ayah(surah, verse):
	conn = get_db_connection('db/quran.db')
	arabic = conn.execute(f'select text from verses where sura = {surah} and ayah = {verse}').fetchone()
	conn.close()
	return arabic['text']

def get_translation(surah, verse):
	conn = get_db_connection('db/en_quran.db')
	translation = conn.execute(f'select text from verses where sura = {surah} and ayah = {verse}').fetchone()
	conn.close()
	return translation['text']

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
	x = pd.read_json('db/quran_stat.json')
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	if surah > 114 or surah < 1:
		return False
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
	'translation' : get_translation(surah, verse),
	'wordforword' : a,
	'definitions' : b,
	'morph' : get_morph(surah, verse),
	'en_kathir' : Markup(get_en_kathir(surah, verse).replace('\n', '<br>')),
	'bn_zakaria' : Markup(get_bn_zakaria(surah, verse).replace('\n', '<br>'))
	}

def get_full_tranlation(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = pd.read_json('db/quran_stat.json')
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	conn = get_db_connection('db/en_quran.db')
	result = conn.execute(f'select text from verses where sura = {surah}').fetchall()
	conn.close()
	x = [x['text'] for x in result]
	return curr_surah, zip(list(range(1, len(x)+1)), x)


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

def get_full_arabic(surah):
	if (surah < 1 or surah > 114): abort(404)

	x = pd.read_json('db/quran_stat.json')
	curr_surah = x['Surah'].iloc[surah-1].split('.')[1].strip()
	conn = get_db_connection('db/quran.db')
	result = conn.execute(f'select text from verses where sura = {surah}').fetchall()
	conn.close()

	x = [x['text'] for x in result]
	return curr_surah, zip(list(range(1, len(x)+1)), x)


def p_getSurahInfo(surah, verse):
	if validate(surah, verse) == False:
		abort(404)
	b = {}
	with open(f'db2/{surah}_{verse}.pickle', 'rb') as handle:
	    b = pickle.load(handle)
	return b