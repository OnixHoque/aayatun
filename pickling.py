import pickle
import library
from tqdm import tqdm

# import gc

# gc.disable()

SAVE_PATH = 'db2/'

def picklify(surah, verse):
	a = library.getSurahInfo(surah, verse)

	with open(SAVE_PATH + f'{surah}_{verse}.pickle', 'wb') as handle:
	    pickle.dump(a, handle, protocol=pickle.HIGHEST_PROTOCOL)
	return True

def unpicklify(surah, verse):
	b = {}
	with open(SAVE_PATH + f'{surah}_{verse}.pickle', 'rb') as handle:
	    b = pickle.load(handle)
	return b

	# print a == b

verses = []

with open('db/quran_index.txt') as f:
	verses = eval(f.read())

# print(verses[4964]) #4965
for v in tqdm(verses[4964::-1]):
	# print(v[0], v[1])
	picklify(v[0], v[1])
# picklify(4, 170)
# gc.enable()