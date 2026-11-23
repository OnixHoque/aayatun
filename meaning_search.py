"""Optional semantic service client and reciprocal rank fusion."""
import json
import hashlib
import os
import re
import urllib.error
import urllib.request

from markupsafe import Markup
import searchtool
from searchnorm import snippet


def search(query, limit, field):
    meta = {'suggestions': [], 'corrected': None, 'truncated': False, 'error': None}
    endpoint = os.environ.get('AAYATUN_SEMANTIC_URL', '').rstrip('/')
    if not endpoint or field not in ('all', 'translation'):
        meta['error'] = 'Meaning search requires the translation corpus and a configured semantic service.'
        return [], meta
    if not query.strip() or len(query) > 1000:
        meta['error'] = 'Enter a question of up to 1,000 characters.'
        return [], meta
    try:
        request = urllib.request.Request(endpoint + '/search',
                                         data=json.dumps({'query': query}).encode(),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read(65536))
        refs = payload['refs']
        if not isinstance(refs, list) or len(refs) > 10 or any(
                not isinstance(ref, str) or not re.fullmatch(r'\d{1,3}:\d{1,3}', ref) for ref in refs):
            raise ValueError('invalid references')
    except (OSError, ValueError, KeyError, TypeError):
        meta['error'] = 'Meaning search is temporarily unavailable. Try keyword search.'
        return [], meta
    lexical, _ = searchtool.index_search(query, 10, field='translation')
    lexical_refs = [f"{hit['surah']}:{hit['verse']}" for hit in lexical]
    scores = {}
    for ranking in [lexical_refs, list(dict.fromkeys(refs))]:
        for rank, ref in enumerate(ranking, 1):
            scores[ref] = scores.get(ref, 0) + 1 / (60 + rank)
    # Match the benchmark's two ten-candidate lists and stable tie break.
    ordered = sorted(scores, key=scores.get, reverse=True)[:10]
    cap = 10 if limit is None else max(0, min(limit, 10))
    conn = searchtool._connect()
    results = []
    try:
        corpus = {f'{s}:{v}': text for s, v, text in
                  conn.execute('SELECT surah, verse, en FROM docs')}
        corpus_hash = hashlib.sha256(json.dumps(corpus, sort_keys=True).encode()).hexdigest()
        if payload.get('corpus') != corpus_hash:
            meta['error'] = 'Meaning search index does not match the verse corpus.'
            return [], meta
        for ref in ordered[:cap]:
            surah, verse = map(int, ref.split(':'))
            row = conn.execute('SELECT * FROM docs WHERE surah=? AND verse=?',
                               (surah, verse)).fetchone()
            if row is None:
                meta['error'] = 'Meaning search index does not match the verse corpus.'
                return [], meta
            item = searchtool._format([row], [], offset=len(results))[0]
            item['chips'] = ['Verse', 'Translation']
            item['ayah'] = Markup(snippet(row['ar_orig'], []))
            item['translation'] = Markup(snippet(row['en'], []))
            results.append(item)
    finally:
        conn.close()
    return results, meta
