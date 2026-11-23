"""Run with python -m unittest test_search_ranking from the repository root."""
import re
import sqlite3
import unittest
import pickle
import tempfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import app
from build_search import add_english_index
from searchtool import index_search


class TranslationRankingTests(unittest.TestCase):
    def test_upgrade_keeps_document_ids_and_can_be_retried(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE docs(en_norm)')
            db.execute("INSERT INTO docs(rowid,en_norm) VALUES (42,'pledged')")
            db.commit()
            for attempt in range(2):
                add_english_index(db)
            hits = db.execute("SELECT rowid FROM english_stem WHERE english_stem MATCH 'pledge'")
            self.assertEqual(hits.fetchall(), [(42,)])

    def test_translation_ranking_through_flask(self):
        client = app.test_client()
        for query, verse in [('pledge tree reward', '48:18'), ('rope of Allah', '3:103'),
                             ('debt scribe term', '2:282'), ('light upon light', '24:35')]:
            with self.subTest(query=query):
                response = client.post('/search/', data={
                    'target_field': 'translation:', 'query_str': query, 'limit': '5'})
                self.assertEqual(response.status_code, 200)
                refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
                self.assertEqual(refs[0], verse)
                self.assertEqual(len(refs), len(set(refs)))
                self.assertLessEqual(len(refs), 5)
        self.assertEqual(client.post('/search/', data={'query_str': '2:255'}).status_code, 302)
        self.assertEqual(client.post('/search/', data={'query_str': ' '}).status_code, 200)

    def test_stemmed_words_are_highlighted(self):
        hits, _ = index_search('pledge tree reward', 1, field='translation')
        self.assertIn('Translation', hits[0]['chips'])
        self.assertIn('>pledged</span>', hits[0]['translation'])

class MixedScriptRankingTests(unittest.TestCase):
    def test_surah_name_and_arabic_prefix_through_flask(self):
        client = app.test_client()
        for query, expected in [('luqman حمل', '31:14'), ('yusuf بقميص', '12:93'),
                                ('nur زيتون', '24:35')]:
            with self.subTest(query=query):
                response = client.post('/search/', data={'query_str': query, 'limit': '5'})
                self.assertEqual(response.status_code, 200)
                refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
                self.assertIn(expected, refs)
                self.assertEqual(len(refs), len(set(refs)))

    def test_surah_prefix_tier_respects_field_and_explicit_syntax(self):
        from searchtool import _ranked_queries
        for raw, field in [('luqman حمل', 'ar_norm'), ('"luqman حمل"', None),
                           ('luqman AND حمل', None), ('luqman حمل*', None)]:
            with self.subTest(raw=raw, field=field):
                self.assertFalse(any('surah_name :' in q for q in
                                     _ranked_queries(raw, field, {}, None, None)))

    def test_terms_can_match_the_arabic_and_translation_of_one_verse(self):
        client = app.test_client()
        for query, expected in [('النحل mountains', '16:68'), ('النمل dwellings', '27:18'),
                                ('العنكبوت home', '29:41'), ('কষ্টের সাথে relief', '94:6')]:
            with self.subTest(query=query):
                response = client.post('/search/', data={'query_str': query, 'limit': '1'})
                self.assertEqual(response.status_code, 200)
                refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
                self.assertEqual(refs, [expected])


class ArabicRootSearchTests(unittest.TestCase):
    def test_root_index_is_atomic_and_retryable(self):
        from searchtool import _ensure_root_index
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / 'metadata.db'
            with closing(sqlite3.connect(metadata)) as source:
                source.execute('CREATE TABLE verses (surah INTEGER, verse INTEGER, data BLOB)')
                source.execute('INSERT INTO verses VALUES (?, ?, ?)',
                               (1, 1, pickle.dumps({'morph': []})))
                source.commit()
            with sqlite3.connect(':memory:') as index:
                index.row_factory = sqlite3.Row
                index.execute('CREATE TABLE docs (surah INTEGER, verse INTEGER)')
                index.execute('INSERT INTO docs VALUES (1, 1)')
                index.commit()
                with patch('searchtool._MORPH_PATH', str(metadata)):
                    with self.assertRaises(ValueError):
                        _ensure_root_index(index)
                    self.assertIsNone(index.execute(
                        "SELECT name FROM sqlite_master WHERE name='root_occurrences'").fetchone())
                    with closing(sqlite3.connect(metadata)) as source:
                        source.execute('UPDATE verses SET data = ?',
                                       (pickle.dumps({'morph': [{'root': 'رحم', 'word': 'الرَّحْمَٰنِ'}]}),))
                        source.commit()
                    _ensure_root_index(index)
                    _ensure_root_index(index)
                    self.assertEqual(index.execute(
                        'SELECT count(*) FROM root_occurrences WHERE root = ?', ('رحم',)).fetchone()[0], 1)

    def test_root_search_and_surah_variants_through_flask(self):
        client = app.test_client()
        for query, expected in [('root:رحم', ['1:1', '1:3']),
                                ('surah:fatiha root:رحم', ['1:1', '1:3']),
                                ('surah:1 root:رَحْم', ['1:1', '1:3']),
                                ('Fatiha رحم', ['1:1', '1:3']),
                                ('Luqman حمل', ['31:14'])]:
            with self.subTest(query=query):
                response = client.post('/search/', data={'query_str': query, 'limit': '10'})
                self.assertEqual(response.status_code, 200)
                refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
                for ref in expected:
                    self.assertIn(ref, refs)
                self.assertEqual(len(refs), len(set(refs)))

    def test_unknown_surah_and_incompatible_field_are_reported(self):
        client = app.test_client()
        for query, field, message in [
                ('surah:unknown root:رحم', 'all:', 'Surah name is unknown or ambiguous'),
                ('root:رحم', 'translation:', 'select the entire Quran or the Arabic verse')]:
            with self.subTest(query=query):
                response = client.post('/search/', data={'query_str': query, 'target_field': field})
                self.assertIn(message, response.get_data(as_text=True))
