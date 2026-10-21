from flask import Flask, render_template, send_from_directory
from werkzeug.exceptions import abort
import pandas as pd
import library as lib
import random
import ast
import hmac
import os
import secrets
import time
from functools import lru_cache
from datetime import datetime
from urllib.parse import urlparse
from flask import request, redirect, session, jsonify, make_response
import searchtool as st

@lru_cache(maxsize=1)
def getVerseMaps():
	x = pd.read_json('db/quran_stat.json')
	return tuple({'surah': i, 'verse_count': j, 'surah_no': k} for i, j, k in zip(list(x['Surah']), list(x['Verses']), range(1, 115)))

def getRukuList():
	with open('db/ruku_index.txt') as f:
		return ast.literal_eval(f.read())

RUKU_LIST = getRukuList()

app = Flask(__name__)

# Session signing key for the nav API token. Prefer an env var; otherwise keep
# a generated key in a gitignored file so sessions survive reloads/restarts and
# stay valid across the workers on one host.
def load_secret_key():
	key = os.environ.get('AAYATUN_SECRET_KEY')
	if key:
		return key
	path = 'db/.secret_key'
	# Several workers may start at once: create the file atomically, then let
	# the losers read the winner's key instead of generating a different one.
	for _ in range(10):
		try:
			with open(path) as f:
				key = f.read().strip()
			if key:
				return key
		except OSError:
			pass
		try:
			fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
		except FileExistsError:
			time.sleep(0.05)
			continue
		except OSError:
			break
		key = secrets.token_hex(32)
		with os.fdopen(fd, 'w') as f:
			f.write(key)
		return key
	try:
		with open(path) as f:
			key = f.read().strip()
		if key:
			return key
	except OSError:
		pass
	# Read-only deploy without AAYATUN_SECRET_KEY set: sessions will not be
	# shared between workers, but the page still works via full navigations.
	return secrets.token_hex(32)

app.secret_key = load_secret_key()
app.config.update(
	SESSION_COOKIE_HTTPONLY=True,
	SESSION_COOKIE_SAMESITE='Lax',
	# Set AAYATUN_HTTPS=1 in production so the cookie is only sent over TLS.
	SESSION_COOKIE_SECURE=os.environ.get('AAYATUN_HTTPS') == '1',
)

# The verse nav API is for this site's own pages only. A browser token cannot
# be truly secret (it ships in the page), so the goal is narrower: block
# third-party sites/hotlinking, bind requests to a session, and keep the token
# revocable. Cross-origin reads are additionally blocked because no CORS
# headers are sent.
def api_token():
	tok = session.get('api_token')
	if not tok:
		tok = secrets.token_urlsafe(32)
		session['api_token'] = tok
	return tok

def same_site_request():
	site = request.headers.get('Sec-Fetch-Site')
	if site and site not in ('same-origin', 'same-site'):
		return False
	ref = request.headers.get('Origin') or request.headers.get('Referer')
	if ref:
		if urlparse(ref).netloc != request.host:
			return False
	return True

def require_api_token():
	tok = session.get('api_token')
	sent = request.headers.get('X-Aayatun-Token', '')
	if not tok or not sent or not hmac.compare_digest(tok, sent):
		abort(403)
	if not same_site_request():
		abort(403)

def no_store(resp):
	resp.headers['Cache-Control'] = 'private, no-store'
	return resp

def private_page(resp):
	# The verse HTML now carries the per-session API token, so shared caches
	# must never store it (a cached page would hand one session's token to
	# another, and its API calls would then be rejected).
	resp.headers['Cache-Control'] = 'private, max-age=0, must-revalidate'
	return resp


@app.route('/service-worker.js', methods=['GET'])
def sw():
    return app.send_static_file('service-worker.js'), 200, {'Content-Type': 'text/javascript'}

@app.route('/')
def index():
	i, j = random.choice(RUKU_LIST)
	return render_template('index.html', surahs=getVerseMaps(), rand_surah=(i, j))

@app.route('/<int:surah>/', strict_slashes=False)
def details2(surah):
	return private_page(make_response(render_template('versedetails.html',
		details=lib.get_verse_details(surah, 1), api_token=api_token())))

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
	return private_page(make_response(render_template('versedetails.html',
		details=lib.get_verse_details(surah, verse), api_token=api_token())))

# Lightweight payload used by next/prev navigation. Only the parts that change
# on screen are sent; accordion sections are fetched on demand.
@app.route('/api/v1/verse/<int:surah>/<int:verse>', strict_slashes=False)
def verse_api(surah, verse):
	require_api_token()
	return no_store(jsonify(lib.get_verse_core(surah, verse)))

# Server-rendered accordion content, so the markup has a single source of truth
# (the Jinja partials) instead of being rebuilt in JavaScript.
@app.route('/api/v1/verse/<int:surah>/<int:verse>/<section>', strict_slashes=False)
def verse_section_api(surah, verse, section):
	require_api_token()
	if section not in lib.VERSE_SECTIONS:
		abort(404)
	html = render_template('partials/_section_%s.html' % section,
		details=lib.get_verse_details(surah, verse))
	resp = make_response(html)
	resp.headers['Content-Type'] = 'text/html; charset=utf-8'
	return no_store(resp)


@app.route('/font/v4/<int:page>.woff2', strict_slashes=False)
def qcf_font(page):
	# quran.com's per-page TajweedV4 (colrv1) mushaf fonts, cached on disk;
	# immutable per page, so they cache hard in the browser + service worker.
	if not (1 <= page <= 604):
		abort(404)
	b = lib.get_qcf_font(page)
	if not b:
		abort(404)
	resp = app.response_class(b, mimetype='font/woff2')
	resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
	return resp

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

@app.route("/prayer-time")
def prayer_time():
	return send_from_directory(".", "prayer-time.html")
