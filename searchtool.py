import pickle
import pandas as pd
import library
from tqdm import tqdm
from pprint import pprint
import os
from whoosh.fields import Schema, TEXT, ID
from whoosh import index
import os, os.path
from whoosh import index
from whoosh import qparser
from whoosh.qparser import QueryParser
from flask import Markup

def process_result(res, col):
	return Markup(res.highlights(col))


def index_search(search_query, result_limit=10, dirname="db3", search_fields=['ayah','translation', 'surah_name', 'en_tafsir', 'bn_tafsir']):
    ix = index.open_dir(dirname)
    schema = ix.schema
    
    og = qparser.OrGroup.factory(0.9)
    mp = qparser.MultifieldParser(search_fields, schema, group = og)

    
    q = mp.parse(search_query)
    
    ret = []
    suggestion = []
    with ix.searcher() as s:
    	corrector = s.corrector("en_tafsir")
    	for mistyped_word in search_query.split(' '):
    		suggestion.extend(corrector.suggest(mistyped_word, limit=3))
    	suggestion_str = ''
    	if len(suggestion) == 1:
    		suggestion_str = suggestion[0]
    	elif len(suggestion) == 2:
    		suggestion_str = Markup(suggestion[0] + '</strong> or <strong>' + suggestion[1])
    	elif len(suggestion) == 3:
    		suggestion_str = Markup('</strong>, <strong>'.join(suggestion[:-1]) + '</strong>, or <strong>' + suggestion[-1])
    	
    	results = s.search(q, terms=True, limit = result_limit)
    	fields = ['ayah','translation', 'en_tafsir', 'bn_tafsir']
    	ser = 1
    	for r in results:
    		w = {j: process_result(r, j) for j in fields}
    		w['en_tafsir'] = w['en_tafsir'].replace('<br>', '')
    		w['bn_tafsir'] = w['bn_tafsir'].replace('<br>', '')
    		w['ser'] = str(ser)
    		ser += 1
    		w['actual_translation'] = r['translation']
    		w['surah'] = r['path'].split("_")[0]
    		w['verse'] = r['path'].split("_")[1]
    		w['surah_name'] = r['surah_name']
    		w['matched_term'] = results.matched_terms()
    		ret.append(w)
    return ret, suggestion_str
    	# if results.has_matched_terms():
    	# 	print(results.matched_terms())
    # for hit in results:
    # 	print(hit.matched_terms())

def create_index(n=None):
	schema = Schema(ayah=TEXT(stored=True), translation=TEXT(stored = True), surah_name=TEXT(stored = True), en_tafsir=TEXT(stored = True), bn_tafsir=TEXT(stored = True), path=ID(stored=True))

	# create empty index directory

	if not os.path.exists("db3"):
	    os.mkdir("db3")

	ix = index.create_in("db3", schema)
	writer = ix.writer()

	df = pd.read_json('pd_backup.json')
	if n is None:
		n = len(df)
	for i in tqdm(range(n), position = 0, leave=True):
	    writer.add_document(ayah=str(df.ayah.iloc[i]), 
	    				translation=str(df.translation.iloc[i]),
	    				en_tafsir=str(df.en_kathir.iloc[i]),
	    				surah_name=str(df.surah_name.iloc[i]),
	    				bn_tafsir=str(df.bn_zakaria.iloc[i]),
	                    path=str(df.surah.iloc[i])+'_'+str(df.verse.iloc[i]))
	writer.commit()



def create_pd_data():
	z = []
	with open('db/quran_index.txt') as f:
			z = eval(f.read())
	# x = library.p_getSurahInfo(z[0][0], z[0][1]);
	# pprint(x)

	search_key = ['surah', 'verse', 'surah_name', 'ayah', 'translation', 'bn_zakaria', 'en_kathir']
	pd_key = {a : [] for a in search_key}

	for i in tqdm(z):
		m = library.p_getSurahInfo(i[0], i[1]);
		for s in search_key:
			pd_key[s].append(m[s])

	y = pd.DataFrame(pd_key)

	y.to_json('pd_backup.json')
	pprint(y.head())


# create_index()
# results_dict, suggestion = index_search("হিজরত", 10)

# print(len(results_dict))
# pprint(results_dict)
# pprint(suggestion)
