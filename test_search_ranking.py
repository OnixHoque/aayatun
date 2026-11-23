"""Run with python -m unittest test_search_ranking from the repository root."""
import re
import sqlite3
import unittest

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
    def test_terms_can_match_the_arabic_and_translation_of_one_verse(self):
        client = app.test_client()
        for query, expected in [('النحل mountains', '16:68'), ('النمل dwellings', '27:18'),
                                ('العنكبوت home', '29:41'), ('কষ্টের সাথে relief', '94:6')]:
            with self.subTest(query=query):
                response = client.post('/search/', data={'query_str': query, 'limit': '1'})
                self.assertEqual(response.status_code, 200)
                refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
                self.assertEqual(refs, [expected])
