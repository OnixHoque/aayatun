import pickle
import pandas as pd
import library
from tqdm import tqdm
from pprint import pprint

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


def convert_db():
	verses = []

	with open('db/quran_index.txt') as f:
		verses = eval(f.read())

	# print(verses[4964]) #4965
	for v in tqdm(verses[4964::-1]):
		# print(v[0], v[1])
		picklify(v[0], v[1])
	# picklify(4, 170)
	# gc.enable()



x = library.p_getSurahInfo(1, 4);
z = x['morph'][0]
y = pd.read_json('db/sarf.json')





pprint(z)
pprint(add_root_def(z))

class RootDefAdder:
	def __init__(self, details):
		self.sarf_db = pd.read_json('db/sarf.json')
		self.details = details;

	def get_root_def(self, root):
		x = self.sarf_db.query(f'Root == "{root}"')[["Baab", "Description", "Form"]]
		return [(j["Baab"], j["Form"], j["Description"]) for i, j in x.iterrows()]

	def add_root_def(self, item):
		item['root_def'] = self.get_root_def(item['root'])
		return item

	def update(self):

