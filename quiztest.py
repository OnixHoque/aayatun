import pandas as pd
import library as lib
import random
from datetime import datetime
from pprint import pprint

def getVerseMaps():
	x = pd.read_json('db/quran_stat.json')
	return [ {'surah': i, 'verse_count': j, 'surah_no': k} for i, j, k in zip(list(x['Surah']), list(x['Verses']), range(1, 115))]



def getRandomVerses(n=10):
	idx = getVerseMaps()
	random.seed(datetime.now())
	surahs = random.sample(range(1, 115), n)
	# print(surahs)
	verses = [random.randint(1, idx[i-1]['verse_count']) for i in surahs]
	return list(zip(surahs, verses))

x = getRandomVerses()
y = [lib.p_getSurahInfo(i[0], i[1]) for i in x]
# dict_keys(['surah_name', 'surah', 'verse', 'prev', 'next', 'ayah', 'translation', 'wordforword', 'definitions', 'morph', 'en_kathir', 'bn_zakaria'])

translations = sorted([i['translation'] for i in y], key=len, reverse=True)
pprint(translations)
# pprint(len(getVerseMaps()))
