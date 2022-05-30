from flask import Flask, render_template
import pandas as pd
import library as lib
import random
from datetime import datetime
from flask import request, redirect
import searchtool as st

def getVerseMaps():
	x = pd.read_json('db/quran_stat.json')
	return [ {'surah': i, 'verse_count': j, 'surah_no': k} for i, j, k in zip(list(x['Surah']), list(x['Verses']), range(1, 115))]

app = Flask(__name__)

@app.route('/service-worker.js', methods=['GET'])
def sw():
    return app.send_static_file('service-worker.js'), 200, {'Content-Type': 'text/javascript'}

@app.route('/')
def index():
	idx = getVerseMaps()
	random.seed(datetime.now())
	# i = random.randint(1, 114)
	# j = random.randint(1, idx[i-1]['verse_count'])
	p = [(i, j) for i in range(1, 115) for j in range(1, idx[i - 1]['verse_count'] + 1)]
	i, j = p[random.randint(0, len(p))]
	resp =  render_template('index.html', surahs=getVerseMaps(), rand_surah = (i, j))
	# resp.set_cookie('userID', user)
	return resp

@app.route('/<int:surah>/', strict_slashes=False)
def details2(surah):
	return render_template('versedetails.html', details=lib.p_getSurahInfo(surah, 1))

@app.route('/search/', strict_slashes=False, methods = ['POST'])
def search():
	query_str = request.form['query_str']
	n = 25
	query_str_filter = query_str
	t = "all:"
	try:
		t = request.form['target_field']
		if t == "all:":
			query_str_filter = query_str.strip()
		else:
			query_str_filter = t + "(" + query_str.strip() + ")"
	except Exception:
		pass

	try:
		m = request.form['limit']
		if m == "-1":
			n = None
		else:
			n = int(m)
	except Exception:
		pass

	results_dict, suggestion = st.index_search(query_str_filter, n)
	if n is None:
		n = -1

	return render_template('search.html', query=query_str, results=results_dict, suggestions=suggestion, limit_label=n, filter_value=t)

# @app.route('/search/<query_str>', strict_slashes=False, methods = ['POST'])
# def search2(query_str):
# 	query_str = request.form['query_str']
# 	return render_template('search.html', query=query_str)

@app.route('/<int:surah>/<int:verse>', strict_slashes=False)
def details(surah, verse):
	return render_template('versedetails.html', details=lib.p_getSurahInfo(surah, verse))

@app.route('/translation/<int:surah>', strict_slashes=False)
def translation(surah):
	a, b = lib.get_full_tranlation(surah)
	prev_ = surah - 1 if surah != 1 else 114
	next_ = surah + 1 if surah != 114 else 1
	return render_template('translation.html', surah_name=a, surah_no=surah, verses=b, prev=prev_, nxt=next_)

@app.route('/tafsir/bn/<int:surah>', strict_slashes=False)
def bn_tafsir(surah):
	a, b = lib.get_full_bn_tafsir(surah)
	prev_ = surah - 1 if surah != 1 else 114
	next_ = surah + 1 if surah != 114 else 1
	return render_template('bn_tafsir.html', surah_name=a, surah_no=surah, verses=b, prev=prev_, nxt=next_)

@app.route('/tafsir/en/<int:surah>', strict_slashes=False)
def en_tafsir(surah):
	a, b = lib.get_full_en_tafsir(surah)
	prev_ = surah - 1 if surah != 1 else 114
	next_ = surah + 1 if surah != 114 else 1
	return render_template('en_tafsir.html', surah_name=a, surah_no=surah, verses=b, prev=prev_, nxt=next_)

@app.route('/mushaf/<int:surah>', strict_slashes=False)
def arabic_fulltext(surah):
	a, b = lib.get_full_arabic(surah)
	c, d = lib.get_full_tranlation(surah)
	prev_ = surah - 1 if surah != 1 else 114
	next_ = surah + 1 if surah != 114 else 1
	return render_template('arabic_fulltext.html', surah_name=a, surah_no=surah, verses=b,translation=list(d), prev=prev_, nxt=next_, mushaf='1')

