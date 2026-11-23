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
import searchtool
from searchtool import index_search


class TranslationRankingTests(unittest.TestCase):
    def test_upgrade_keeps_document_ids_and_can_be_retried(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE docs(en_norm, ai_norm, en_tafsir_norm)')
            db.execute("INSERT INTO docs(rowid,en_norm,ai_norm,en_tafsir_norm) "
                       "VALUES (42,'pledged','teachings','believers')")
            db.execute("CREATE VIRTUAL TABLE english_stem USING fts5("
                       "en_norm, tokenize='porter unicode61')")
            db.execute("INSERT INTO english_stem(rowid,en_norm) VALUES (42,'pledged')")
            db.commit()
            for attempt in range(2):
                add_english_index(db)
            self.assertEqual([row[1] for row in db.execute('PRAGMA table_info(english_stem)')],
                             ['en_norm', 'ai_norm', 'en_tafsir_norm'])
            for query in ('pledge', 'teaching', 'believer'):
                hits = db.execute(
                    "SELECT rowid FROM english_stem WHERE english_stem MATCH ?", (query,))
                self.assertEqual(hits.fetchall(), [(42,)])

    def test_old_schema_migration_rolls_back_and_can_be_retried(self):
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE docs(en_norm)')
            db.execute("INSERT INTO docs(rowid,en_norm) VALUES (42,'pledged')")
            db.execute("CREATE VIRTUAL TABLE english_stem USING fts5("
                       "en_norm, tokenize='porter unicode61')")
            db.execute("INSERT INTO english_stem(rowid,en_norm) VALUES (42,'pledged')")
            db.commit()
            with self.assertRaises(sqlite3.OperationalError):
                add_english_index(db)
            self.assertEqual([row[1] for row in db.execute('PRAGMA table_info(english_stem)')],
                             ['en_norm'])
            self.assertEqual(db.execute(
                "SELECT rowid FROM english_stem WHERE english_stem MATCH 'pledge'").fetchall(),
                [(42,)])
            db.execute('ALTER TABLE docs ADD COLUMN ai_norm')
            db.execute('ALTER TABLE docs ADD COLUMN en_tafsir_norm')
            db.execute("UPDATE docs SET ai_norm='teachings', en_tafsir_norm='believers'")
            db.commit()
            add_english_index(db)
            self.assertEqual(db.execute('SELECT rowid FROM english_stem').fetchall(), [(42,)])

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

class CrossFieldRankingTests(unittest.TestCase):
    def test_generic_and_surah_tiers_match_different_columns(self):
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.execute("""CREATE VIRTUAL TABLE docs USING fts5(
                ar_norm, en_norm, ai_norm, en_tafsir_norm, bn_tafsir_norm, surah_name,
                surah UNINDEXED, verse UNINDEXED, ar_orig UNINDEXED, en UNINDEXED,
                en_tafsir UNINDEXED, bn_tafsir UNINDEXED, ai UNINDEXED)""")
            db.execute("INSERT INTO docs VALUES ('','','','','','Luqman',31,1,'','','','','')")
            db.execute("INSERT INTO docs VALUES ('','parent','','','','Luqman',31,14,'','','','','')")
            generic = searchtool._cross_field_expr(
                ['luqman', 'parent'], searchtool._ALL_COLUMNS, {})
            same_column = ' OR '.join(
                f'{column} : (luqman AND parent)' for column in searchtool._ALL_COLUMNS)
            self.assertEqual(searchtool._run_query(db, same_column, 10), [])
            self.assertEqual(searchtool._run_query(db, generic, 10)[0]['verse'], 14)

    def test_luqman_parent_has_cross_field_tiers(self):
        conn = searchtool._connect()
        try:
            gloss = searchtool._load_glossary()
            match, _ = searchtool._build_match('Luqman Parent', None, gloss)
            full, _ = searchtool._build_match('Luqman Parent', None, gloss, join='AND')
            queries = searchtool._ranked_queries('Luqman Parent', None, gloss, full, match, conn)
            scoped = next(i for i, q in enumerate(queries)
                          if q.startswith('surah_name : (luqman) AND {'))
            generic = next(i for i, q in enumerate(queries)
                           if q.startswith('{') and ' AND ' in q)
            self.assertLess(scoped, generic)
        finally:
            conn.close()

    def test_luqman_parent_puts_parent_verse_in_top_five(self):
        hits, _ = index_search('Luqman Parent', 5, field='all')
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        self.assertIn('31:14', refs)
        self.assertEqual(len(refs), len(set(refs)))

    def test_cross_field_knob_can_be_disabled(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool.SEARCH_CROSS_FIELD_AND', False):
                queries = searchtool._ranked_queries(
                    'Luqman Parent', None, searchtool._load_glossary(), None, None, conn)
            self.assertFalse(any(q.startswith('surah_name :') or
                                 (q.startswith('{') and 'surah_name' in q) for q in queries))
            self.assertTrue(any(q.startswith('{en_norm ai_norm en_tafsir_norm}')
                                for q in queries))
        finally:
            conn.close()
        with patch('searchtool.SEARCH_CROSS_FIELD_AND', False), \
                patch('searchtool.SEARCH_ENGLISH_STEMMING', False), \
                patch('searchtool.SEARCH_AI_TAFSIR_TIERS', False):
            hits, _ = index_search('Luqman Parent', 5, field='all')
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        self.assertNotIn('31:14', refs)

    def test_explicit_syntax_and_field_scope_bypass_cross_field_tiers(self):
        for raw, col in [('"Luqman Parent"', None), ('Luqman AND Parent', None),
                         ('Luqman Parent*', None), ('Luqman', None),
                         ('Luqman Parent', 'en_norm')]:
            with self.subTest(raw=raw, col=col):
                queries = searchtool._ranked_queries(raw, col, {}, None, None)
                self.assertFalse(any(q.startswith('{') for q in queries))

    def test_benchmark_coverage_counts_prefix_inflections(self):
        from evaluation.compare_keyword_knobs import coverage_at_five

        case = {'query': 'Luqman Parent', 'intent': 'multi', 'language': 'en'}
        corpus = {'31:14': {'luqman', 'parents'}}
        self.assertEqual(coverage_at_five(case, ['31:14'], corpus), 1.0)


class EnglishStemmingRankingTests(unittest.TestCase):
    def _stem_index(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.execute('''CREATE TABLE docs(
            en_norm, ai_norm, en_tafsir_norm, surah_name, surah, verse,
            ar_orig, en, ai, en_tafsir, bn_tafsir)''')
        rows = [
            ('parents', '', '', 'Luqman', 31, 14, '', 'parents', '', '', ''),
            ('', 'teachings', '', 'The Cow', 2, 1, '', '', 'teachings', '', ''),
            ('', '', 'believers', 'The Family of Imran', 3, 1,
             '', '', '', 'believers', ''),
            ('parents', 'teachings', '', 'The Women', 4, 1,
             '', 'parents', 'teachings', '', ''),
        ]
        db.executemany('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)
        db.commit()
        add_english_index(db)
        return db

    def test_inflections_and_chips_cover_all_english_fields(self):
        with closing(self._stem_index()) as db:
            for query, ref, chip, span in [
                    ('parent', '31:14', 'Translation', '>parents</span>'),
                    ('teaching', '2:1', 'AI explanation', '>teachings</span>'),
                    ('believer', '3:1', 'Tafsir Ibn Kathir', '>believers</span>')]:
                with self.subTest(query=query):
                    expr = searchtool._stem_expr(
                        [query], searchtool._ENGLISH_STEM_COLUMNS, {})
                    rows = searchtool._run_stem_query(db, expr, 10)
                    refs = [f"{row['surah']}:{row['verse']}" for row in rows]
                    self.assertIn(ref, refs)
                    row = rows[refs.index(ref)]
                    item = searchtool._format([row], [query])[0]
                    self.assertIn(chip, item['chips'])
                    rendered = item['translation'] or item['ai'] or item['en_tafsir']
                    self.assertIn(span, rendered)

    def test_combined_stem_tier_allows_keywords_in_different_fields(self):
        with closing(self._stem_index()) as db:
            expr = searchtool._stem_expr(
                ['parent', 'teaching'], searchtool._ENGLISH_STEM_COLUMNS, {})
            rows = searchtool._run_stem_query(db, expr, 10)
            refs = [f"{row['surah']}:{row['verse']}" for row in rows]
            self.assertIn('4:1', refs)
            self.assertNotIn('2:1', refs)

    def test_surah_stem_tier_precedes_exact_surah_tier(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                tiers = searchtool._ranked_tiers(
                    'Luqman Parent', None, searchtool._load_glossary(), None, None, conn)
            stem_surah = next(i for i, (source, _, surah) in enumerate(tiers)
                              if source == 'stem' and surah == 31)
            exact_surah = next(i for i, (source, expr, _) in enumerate(tiers)
                               if source == 'docs' and expr.startswith('surah_name : (luqman)'))
            self.assertLess(stem_surah, exact_surah)
            stem_and = next(i for i, (source, expr, _) in enumerate(tiers)
                            if source == 'stem' and ' AND ' in expr and _ is None)
            stem_or = next(i for i, (source, expr, _) in enumerate(tiers)
                           if source == 'stem' and ' OR ' in expr and _ is None)
            self.assertLess(stem_and, stem_or)
        finally:
            conn.close()

    def test_field_scope_explicit_syntax_and_non_english_bypass_stemming(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                for raw, col in [('parents teachings', 'ai_norm'),
                                 ('parents teachings', 'en_tafsir_norm'),
                                 ('Luqman AND Parent', None), ('Luqman Parent*', None),
                                 ('Luqman أبو', None), ('Parent', None)]:
                    with self.subTest(raw=raw, col=col):
                        tiers = searchtool._ranked_tiers(raw, col, {}, None, None, conn)
                        self.assertFalse(any(source == 'stem' for source, _, _ in tiers))
        finally:
            conn.close()

    def test_stemming_knob_is_independent_of_cross_field_tiers(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool.SEARCH_CROSS_FIELD_AND', False), \
                    patch('searchtool._english_stem_columns',
                           return_value=searchtool._ENGLISH_STEM_COLUMNS):
                tiers = searchtool._ranked_tiers(
                    'Luqman Parent', None, searchtool._load_glossary(), None, None, conn)
            self.assertTrue(any(source == 'stem' for source, _, _ in tiers))
            self.assertFalse(any(source == 'docs' and expr.startswith('{') and
                                 'surah_name' in expr for source, expr, _ in tiers))
            self.assertTrue(any(source == 'docs' and
                                expr.startswith('{en_norm ai_norm en_tafsir_norm}')
                                for source, expr, _ in tiers))
        finally:
            conn.close()

    def test_knob_rollback_retains_legacy_translation_fallback(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool.SEARCH_ENGLISH_STEMMING', False), \
                    patch('searchtool._english_stem_columns', return_value=['en_norm']):
                tiers = searchtool._ranked_tiers(
                    'pledge tree reward', 'en_norm', {}, None, None, conn)
            stem_tiers = [expr for source, expr, _ in tiers if source == 'stem']
            self.assertEqual(len(stem_tiers), 1)
            self.assertIn(' OR ', stem_tiers[0])
        finally:
            conn.close()

    def test_luqman_parent_puts_parent_verse_first(self):
        hits, _ = index_search('Luqman Parent', 5, field='all')
        self.assertEqual(f"{hits[0]['surah']}:{hits[0]['verse']}", '31:14')


class AiTafsirPhraseRankingTests(unittest.TestCase):
    def _docs_index(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.execute("""CREATE VIRTUAL TABLE docs USING fts5(
            ar_norm, en_norm, ai_norm, en_tafsir_norm, bn_tafsir_norm, surah_name,
            surah UNINDEXED, verse UNINDEXED, ar_orig UNINDEXED, en UNINDEXED,
            en_tafsir UNINDEXED, bn_tafsir UNINDEXED, ai UNINDEXED)""")
        rows = [
            ('', '', 'the strongest parental claims', '', '', 'Luqman', 31, 13,
             '', '', '', '', 'The strongest parental claims are stated here.'),
            ('', '', '', 'hardship mujahid said', '', 'Luqman', 31, 14,
             '', '', 'Hardship, Mujahid said, requires patience.', '', ''),
            ('', 'parent', 'teaching', '', '', 'The Women', 4, 1,
             '', 'Parent', '', '', 'Teaching'),
            ('', '', '', '', 'কষটর সথ', 'The Relief', 94, 6,
             '', '', '', 'কষ্টের সাথে relief', ''),
            ('الحمد لله', '', '', '', '', 'The Opening', 1, 2,
             'الحمد لله', '', '', '', ''),
            ('', 'light upon light', '', '', '', 'The Light', 24, 35,
             '', 'Light upon light', '', '', ''),
            ('', '', '', '', '', 'strongest parental claims', 99, 1,
             '', '', '', '', ''),
        ]
        db.executemany('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
        db.commit()
        return db

    def test_phrase_columns_follow_script_and_field_scope(self):
        self.assertEqual(searchtool._phrase_columns(
            ['strongest', 'parental', 'claims'], None), searchtool._ENGLISH_STEM_COLUMNS)
        self.assertEqual(searchtool._phrase_columns(['الحمد', 'لله'], None), ['ar_norm'])
        self.assertEqual(searchtool._phrase_columns(['কষটর', 'সথ'], None), ['bn_tafsir_norm'])
        self.assertEqual(searchtool._phrase_columns(
            ['النحل', 'mountains'], None), ['ar_norm'] + searchtool._ENGLISH_STEM_COLUMNS)
        self.assertEqual(searchtool._phrase_columns(
            ['parent', 'teaching'], 'en_norm'), ['en_norm'])

    def test_phrases_match_ai_and_english_tafsir_with_chips(self):
        with closing(self._docs_index()) as db:
            for query, ref, chip, item_field, span in [
                    ('strongest parental claims', '31:13', 'AI explanation', 'ai',
                     '>strongest</span>'),
                    ('hardship mujahid said', '31:14', 'Tafsir Ibn Kathir', 'en_tafsir',
                     '>Hardship</span>')]:
                with self.subTest(query=query):
                    _, terms = searchtool._build_match(query, None, {})
                    tiers = searchtool._ranked_tiers(query, None, {}, None, None, db)
                    rows = searchtool._run_query(db, tiers[0][1], 10)
                    refs = [f"{row['surah']}:{row['verse']}" for row in rows]
                    self.assertIn(ref, refs)
                    item = searchtool._format([rows[refs.index(ref)]], terms)[0]
                    self.assertIn(chip, item['chips'])
                    self.assertIn(span, item[item_field])

    def test_english_combined_tier_allows_split_keywords(self):
        with closing(self._docs_index()) as db:
            query = 'parent teaching'
            _, terms = searchtool._build_match(query, None, {})
            tiers = searchtool._ranked_tiers(query, None, {}, None, None, db)
            combined = searchtool._cross_field_expr(
                ['parent', 'teaching'], searchtool._ENGLISH_STEM_COLUMNS, {})
            combined_index = next(i for i, (_, expr, _) in enumerate(tiers)
                                  if expr == combined)
            generic_index = next(i for i, (_, expr, _) in enumerate(tiers)
                                 if expr.startswith('{') and 'surah_name' in expr)
            self.assertLess(combined_index, generic_index)
            rows = searchtool._run_query(db, combined, 10)
            refs = [f"{row['surah']}:{row['verse']}" for row in rows]
            self.assertEqual(refs, ['4:1'])
            item = searchtool._format([rows[0]], terms)[0]
            self.assertIn('Translation', item['chips'])
            self.assertIn('AI explanation', item['chips'])
            self.assertIn('>Parent</span>', item['translation'])
            self.assertIn('>Teaching</span>', item['ai'])

    def test_arabic_bengali_and_surah_name_phrase_behavior(self):
        with closing(self._docs_index()) as db:
            for query, expected in [('الحمد لله', '1:2'), ('কষ্টের সাথে', '94:6')]:
                with self.subTest(query=query):
                    tiers = searchtool._ranked_tiers(query, None, {}, None, None, db)
                    rows = searchtool._run_query(db, tiers[0][1], 10)
                    refs = [f"{row['surah']}:{row['verse']}" for row in rows]
                    self.assertEqual(refs, [expected])
            tiers = searchtool._ranked_tiers(
                'strongest parental claims', None, {}, None, None, db)
            rows = searchtool._run_query(db, tiers[0][1], 10)
            self.assertNotIn('99:1', [f"{row['surah']}:{row['verse']}" for row in rows])

    def test_translation_scope_is_unchanged_by_knob(self):
        with closing(self._docs_index()) as db:
            with patch('searchtool.SEARCH_AI_TAFSIR_TIERS', True):
                enabled = searchtool._ranked_tiers(
                    'light upon light', 'en_norm', {}, None, None, db)
            with patch('searchtool.SEARCH_AI_TAFSIR_TIERS', False):
                disabled = searchtool._ranked_tiers(
                    'light upon light', 'en_norm', {}, None, None, db)
            self.assertEqual(enabled, disabled)

    def test_knob_rollback_restores_legacy_phrase_columns(self):
        with closing(self._docs_index()) as db:
            with patch('searchtool.SEARCH_AI_TAFSIR_TIERS', False):
                tiers = searchtool._ranked_tiers(
                    'strongest parental claims', None, {}, None, None, db)
            self.assertEqual(tiers[0][1],
                             'ar_norm : ("strongest parental claims") OR '
                             'en_norm : ("strongest parental claims")')
            self.assertFalse(any(expr.startswith('{en_norm ai_norm en_tafsir_norm}')
                                 for _, expr, _ in tiers))

    def test_explicit_syntax_and_single_word_bypass_new_tiers(self):
        with closing(self._docs_index()) as db:
            for raw in ['"strongest parental claims"', 'strongest AND parental',
                        'strongest parental*', 'strongest']:
                with self.subTest(raw=raw):
                    tiers = searchtool._ranked_tiers(raw, None, {}, None, None, db)
                    self.assertFalse(any(expr.startswith('{en_norm ai_norm en_tafsir_norm}')
                                         for _, expr, _ in tiers))

    def test_real_commentary_phrases_are_ranked_and_highlighted(self):
        for query, ref, chip in [
                ('strongest parental claims', '31:13', 'AI explanation'),
                ('hardship mujahid said', '31:14', 'Tafsir Ibn Kathir'),
                ('কষ্টের সাথে', '94:6', 'Tafsir Abu Bakr Zakaria')]:
            with self.subTest(query=query):
                hits, _ = index_search(query, 5, field='all')
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
                self.assertIn(ref, refs)
                item = hits[refs.index(ref)]
                self.assertIn(chip, item['chips'])


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
