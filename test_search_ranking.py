"""Run with python -m unittest test_search_ranking from the repository root."""
import re
import sqlite3
import unittest
import pickle
import tempfile
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

from app import app
import build_search
from build_search import add_english_index
import searchtool
from searchtool import index_search


class SearchFormattingTests(unittest.TestCase):
    def test_dictionary_terms_are_not_highlighted_inside_other_words(self):
        row = self._row(89, 22, en='rank upon rank', ai='on the day')
        item = searchtool._format([row], ['on', 'day'], whole_terms={'on', 'day'})[0]
        self.assertEqual(item['chips'], ['AI explanation'])
        self.assertIn('>on</span>', item['ai'])

    def test_known_word_and_fragment_fallback_respects_both_terms(self):
        conn = searchtool._connect()
        try:
            rows = searchtool._run_trigram(conn, 'on eward', 20, 'en_norm')
            self.assertTrue(rows)
            for row in rows:
                text, _ = searchtool.normalize(row['en'])
                self.assertIn('on', text.split())
                self.assertIn('eward', text)
            self.assertEqual(searchtool._run_trigram(conn, 'ward', 20, 'en_norm'), [])
        finally:
            conn.close()

    def test_known_word_is_not_silently_corrected(self):
        rows, meta = index_search('ward', 10, field='translation')
        self.assertEqual(rows, [])
        self.assertIsNone(meta['corrected'])
        self.assertEqual(meta['suggestions'], [])
        self.assertEqual(searchtool._correct_query('ward judgmnet'), ['ward', 'judgment'])

    def test_dictionary_includes_american_and_british_forms(self):
        words = searchtool._english_words()
        for word in ('ward', 'on', 'color', 'colour', 'judgment', 'judgement'):
            self.assertIn(word, words)
        self.assertNotIn('judg', words)

    def _row(self, surah, verse, **fields):
        row = {
            'surah': surah,
            'verse': verse,
            'surah_name': '',
            'ar_orig': '',
            'en': '',
            'en_tafsir': '',
            'bn_tafsir': '',
            'ai': '',
        }
        row.update(fields)
        return row

    def test_all_fields_formatting_does_not_leak_scope_between_rows(self):
        rows = [
            self._row(29, 41, ai='A spider builds a fragile house.'),
            self._row(2, 26, en_tafsir='The spider is mentioned as a parable.'),
        ]
        items = searchtool._format(rows, ['spider'])
        self.assertEqual([(item['surah'], item['verse']) for item in items],
                         [(29, 41), (2, 26)])
        self.assertEqual(items[0]['chips'], ['AI explanation'])
        self.assertEqual(items[1]['chips'], ['Tafsir Ibn Kathir'])
        self.assertEqual(items[1]['ai'], '')
        self.assertIn('<span class="match">spider</span>', items[1]['en_tafsir'])

    def test_stem_highlights_stay_in_the_matching_field(self):
        row = self._row(4, 1, en='mercy pledged', ai='pledged',
                        stem_ai_norm='[pledged]')
        item = searchtool._format([row], ['mercy', 'pledge'])[0]
        self.assertIn('>mercy</span>', item['translation'])
        self.assertNotIn('>pledged</span>', item['translation'])
        self.assertIn('>pledged</span>', item['ai'])

    def test_snippet_centers_on_a_late_match(self):
        text = ('ordinary context ' * 300) + 'the needle appears late'
        rendered = searchtool.snippet(text, ['needle'])
        self.assertIn('<span class="match">needle</span>', rendered)
        self.assertIn('…', rendered)


class BuildSearchConnectionTests(unittest.TestCase):
    def test_load_rows_closes_connection_on_query_failure(self):
        conn = Mock()
        conn.execute.side_effect = sqlite3.OperationalError('query failed')
        with patch('build_search.sqlite3.connect', return_value=conn):
            with self.assertRaises(sqlite3.OperationalError):
                build_search.load_rows()
        conn.close.assert_called_once_with()

    def test_build_closes_output_connection_on_failure(self):
        conn = Mock()
        conn.execute.side_effect = sqlite3.OperationalError('write failed')
        with patch('build_search.load_rows', return_value=[]), \
                patch('build_search.os.path.exists', return_value=False), \
                patch('build_search.sqlite3.connect', return_value=conn):
            with self.assertRaises(sqlite3.OperationalError):
                build_search.build()
        conn.close.assert_called_once_with()


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
                patch('searchtool.SEARCH_AI_TAFSIR_TIERS', False), \
                patch('searchtool.SEARCH_MMR_LAMBDA', 1.0):
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

    def test_translation_literal_tier_precedes_stem_expansion(self):
        conn = searchtool._connect()
        try:
            raw = 'hard times patient worship seek support'
            full, _ = searchtool._build_match(raw, 'en_norm', {}, join='AND')
            match, _ = searchtool._build_match(raw, 'en_norm', {})
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                tiers = searchtool._ranked_tiers(
                    raw, 'en_norm', {}, full, match, conn)
            docs = [expr for source, expr, _ in tiers if source == 'docs']
            stems = [index for index, (source, _, _) in enumerate(tiers)
                     if source == 'stem']
            literal_start = docs.index(full)
            self.assertEqual(docs[literal_start:literal_start + 2], [full, match])
            self.assertLess(tiers.index(('docs', match, None)), min(stems))
        finally:
            conn.close()

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

    def test_translation_surah_scope_only_matches_translation_stems(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                tiers = searchtool._ranked_tiers(
                    'Luqman Parent', 'en_norm', {}, None, None, conn)
            scoped = [(expr, surah) for source, expr, surah in tiers
                      if source == 'stem' and surah == 31]
            self.assertTrue(scoped)
            self.assertTrue(all(expr.startswith('en_norm :') and
                                'ai_norm' not in expr and 'en_tafsir_norm' not in expr
                                for expr, _ in scoped))
        finally:
            conn.close()

    def test_english_field_scopes_use_their_selected_stem_column(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                for col in ('en_norm', 'ai_norm', 'en_tafsir_norm'):
                    with self.subTest(col=col):
                        tiers = searchtool._ranked_tiers(
                            'parents teachings', col, {}, None, None, conn)
                        stem = [expr for source, expr, _ in tiers if source == 'stem']
                        self.assertTrue(stem)
                        self.assertTrue(all(col + ' :' in expr for expr in stem))
        finally:
            conn.close()

    def test_field_scope_explicit_syntax_and_non_english_bypass_stemming(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool._english_stem_columns',
                       return_value=searchtool._ENGLISH_STEM_COLUMNS):
                for raw, col in [('Luqman AND Parent', None), ('Luqman Parent*', None),
                                 ('Luqman أبو', None), ('Parent', None),
                                 ('Luqman AND Parent', 'en_norm'),
                                 ('Luqman AND Parent', 'ai_norm'),
                                 ('Luqman AND Parent', 'en_tafsir_norm'),
                                 ('parents teachings', 'ar_norm'),
                                 ('parents teachings', 'bn_tafsir_norm')]:
                    with self.subTest(raw=raw, col=col):
                        tiers = searchtool._ranked_tiers(raw, col, {}, None, None, conn)
                        self.assertFalse(any(source == 'stem' for source, _, _ in tiers))
        finally:
            conn.close()

    def test_scoped_stem_rows_only_load_the_selected_highlight_column(self):
        with closing(self._stem_index()) as db:
            rows = searchtool._run_stem_query(
                db, 'ai_norm : (teaching)', 10, col='ai_norm')
            self.assertTrue(rows)
            self.assertIn('stem_ai_norm', rows[0].keys())
            self.assertNotIn('stem_en_norm', rows[0].keys())
            self.assertNotIn('stem_en_tafsir_norm', rows[0].keys())
            self.assertIn('[teachings]', rows[0]['stem_ai_norm'])
            self.assertIn('ai', rows[0].keys())
            self.assertNotIn('en_tafsir', rows[0].keys())
            tafsir_rows = searchtool._run_stem_query(
                db, 'en_tafsir_norm : (believer)', 10, col='en_tafsir_norm')
            self.assertTrue(tafsir_rows)
            self.assertIn('[believers]', tafsir_rows[0]['stem_en_tafsir_norm'])
            self.assertNotIn('stem_ai_norm', tafsir_rows[0].keys())
            self.assertNotIn('stem_en_norm', tafsir_rows[0].keys())

    def test_scoped_results_only_render_the_selected_field(self):
        row = {
            'surah': 1, 'verse': 1, 'surah_name': 'Al-Fatihah',
            'ar_orig': 'بسم الله', 'en': 'Parent teaching',
            'ai': 'Parent teaching', 'en_tafsir': 'Parent teaching',
            'bn_tafsir': 'Parent teaching',
        }
        for col, chip, item_field in [
                ('en_norm', 'Translation', 'translation'),
                ('ai_norm', 'AI explanation', 'ai'),
                ('en_tafsir_norm', 'Tafsir Ibn Kathir', 'en_tafsir')]:
            with self.subTest(col=col):
                with patch('searchtool._matched_columns',
                           side_effect=AssertionError('scoped text rescanned')):
                    item = searchtool._format(
                        [row], ['parent', 'teaching'], col=col)[0]
                self.assertEqual(item['chips'], [chip])
                self.assertIn('>Parent</span>', item[item_field])
                for other in ('translation', 'ai', 'en_tafsir'):
                    if other != item_field:
                        self.assertEqual(item[other], '')

    def test_non_trigram_fields_bypass_substring_fallback(self):
        for col in ('ai_norm', 'en_tafsir_norm', 'bn_tafsir_norm'):
            with self.subTest(col=col):
                self.assertEqual(searchtool._run_trigram(None, 'parent', 10, col), [])

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

    def test_stemming_knob_disables_new_ai_and_tafsir_tiers(self):
        conn = searchtool._connect()
        try:
            with patch('searchtool.SEARCH_ENGLISH_STEMMING', False), \
                    patch('searchtool._english_stem_columns',
                           return_value=searchtool._ENGLISH_STEM_COLUMNS):
                for col in ('ai_norm', 'en_tafsir_norm'):
                    with self.subTest(col=col):
                        tiers = searchtool._ranked_tiers(
                            'parents teachings', col, {}, None, None, conn)
                        self.assertFalse(any(source == 'stem' for source, _, _ in tiers))
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


class CoverageMmrRankingTests(unittest.TestCase):
    def test_mmr_eligibility_and_rollback(self):
        for raw, col, limit, expected in [
                ('luqman parent', None, 5, ['luqman', 'parent']),
                ('luqman parent', 'en_norm', 5, ['luqman', 'parent']),
                ('luqman parent', 'ai_norm', 5, ['luqman', 'parent']),
                ('luqman parent', 'en_tafsir_norm', 5, ['luqman', 'parent']),
                ('luqman parent', 'ar_norm', 5, []),
                ('luqman parent', 'bn_tafsir_norm', 5, []),
                ('Luqman أبو', None, 5, []),
                ('Luqman', None, 5, []),
                ('"Luqman Parent"', None, 5, []),
                ('Luqman AND Parent', None, 5, []),
                ('Luqman Parent*', None, 5, []),
                ('Luqman Parent', None, None, []),
                ('Luqman Parent', None, 0, [])]:
            with self.subTest(raw=raw, col=col, limit=limit):
                self.assertEqual(searchtool._mmr_keywords(raw, col, limit), expected)
        with patch('searchtool.SEARCH_MMR_LAMBDA', 1.0):
            self.assertEqual(searchtool._mmr_keywords('Luqman Parent', None, 5), [])
            self.assertEqual(searchtool._mmr_keywords('Luqman Parent', 'en_norm', 5), [])

    def test_term_masks_use_porter_index_in_the_selected_scope(self):
        with closing(EnglishStemmingRankingTests()._stem_index()) as db:
            rows = searchtool._run_stem_query(db, 'parent OR teaching', 10)
            words = ['parent', 'teaching']
            masks = searchtool._matched_term_masks(db, words, rows)
            by_ref = {f"{row['surah']}:{row['verse']}": mask
                      for row, mask in zip(rows, masks)}
            self.assertEqual(by_ref['31:14'], 0b01)
            self.assertEqual(by_ref['2:1'], 0b10)
            self.assertEqual(by_ref['4:1'], 0b11)
            surah_rows = searchtool._run_stem_query(db, 'parent', 10)
            surah_masks = searchtool._matched_term_masks(
                db, ['luqman', 'parent'], surah_rows)
            surah_by_ref = {f"{row['surah']}:{row['verse']}": mask
                            for row, mask in zip(surah_rows, surah_masks)}
            self.assertEqual(surah_by_ref['31:14'], 0b11)
            self.assertEqual(surah_by_ref['4:1'], 0b10)
            scoped = searchtool._matched_term_masks(
                db, ['luqman', 'parent'], surah_rows, 'en_norm')
            scoped_by_ref = {f"{row['surah']}:{row['verse']}": mask
                             for row, mask in zip(surah_rows, scoped)}
            self.assertEqual(scoped_by_ref['31:14'], 0b10)
            index = next(i for i, row in enumerate(rows)
                         if f"{row['surah']}:{row['verse']}" == '4:1')
            for col, expected in [('en_norm', 0b01), ('ai_norm', 0b10),
                                  ('en_tafsir_norm', 0)]:
                with self.subTest(col=col):
                    scoped = searchtool._matched_term_masks(
                        db, words, [rows[index]], col)
                    self.assertEqual(scoped, [expected])

    def test_non_english_term_masks_use_exact_tokens(self):
        rows = [
            {'rowid': 1, 'ar_orig': 'الحمد لله'},
            {'rowid': 2, 'ar_orig': 'الحمد'},
            {'rowid': 3, 'bn_tafsir': 'কষ্টের সাথে relief'},
        ]
        masks = searchtool._matched_term_masks(None, ['الحمد', 'لله'], rows)
        self.assertEqual(masks, [0b11, 0b01, 0])

    def test_coverage_ordering_and_redundancy_reduction(self):
        rows = [{'id': 'partial'}, {'id': 'full'}, {'id': 'novel'}, {'id': 'redundant'}]
        words = ['alpha', 'beta', 'gamma']
        ranked = searchtool._mmr_rerank(
            rows, words, [0b001, 0b111, 0b110, 0b100], 4, 0.7)
        self.assertEqual(ranked[0]['id'], 'full')
        self.assertLess(ranked.index(rows[2]), ranked.index(rows[3]))

    def test_translation_mmr_preserves_four_literal_anchors(self):
        rows = [{'id': f'anchor-{index}'} for index in range(4)]
        rows.extend([{'id': 'novel-1'}, {'id': 'novel-2'}])
        words = ['alpha', 'beta', 'gamma']
        masks = [0b001] * 4 + [0b010, 0b100]
        ranked = searchtool._mmr_rerank(
            rows, words, masks, 5, 0.7, top5_coverage=True,
            preserve_baseline=True)
        self.assertEqual([row['id'] for row in ranked[:4]],
                         [f'anchor-{index}' for index in range(4)])
        self.assertEqual(len(ranked), 5)
        self.assertEqual(len({row['id'] for row in ranked}), 5)
        self.assertIn(ranked[4]['id'], ('novel-1', 'novel-2'))
        complete = searchtool._mmr_rerank(
            rows, words, [0b001] * 4 + [0b111, 0b100], 5, 0.7,
            top5_coverage=True, preserve_baseline=True)
        self.assertEqual(complete[0]['id'], 'novel-1')
        for count, limit in ((2, 10), (2, 1), (0, 5)):
            with self.subTest(count=count, limit=limit):
                short = rows[:count]
                result = searchtool._mmr_rerank(
                    short, words, masks[:count], limit, 0.7,
                    top5_coverage=True, preserve_baseline=True)
                self.assertEqual(len(result), min(count, limit))
                self.assertEqual(len({row['id'] for row in result}), len(result))

    def test_mmr_ties_and_limits_are_deterministic(self):
        rows = [{'id': 'first'}, {'id': 'second'}, {'id': 'third'}]
        words = ['alpha', 'beta']
        masks = [0b01, 0b01, 0b10]
        first = searchtool._mmr_rerank(rows, words, masks, 2, 0.7)
        second = searchtool._mmr_rerank(rows, words, masks, 2, 0.7)
        self.assertEqual(first, second)
        self.assertEqual([row['id'] for row in first], ['first', 'third'])
        all_ranked = searchtool._mmr_rerank(rows, words, masks, 10, 0.7)
        self.assertEqual(len(all_ranked), len(rows))
        self.assertEqual({row['id'] for row in all_ranked}, {row['id'] for row in rows})
        self.assertEqual(searchtool._mmr_rerank(rows, words, masks, 0, 0.7), [])

    def test_candidate_pool_is_fifty_unique_rows(self):
        hits, _ = index_search('luqman parent', 100, field='all')
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        self.assertEqual(len(refs), searchtool.MMR_CANDIDATE_POOL)
        self.assertEqual(len(refs), len(set(refs)))
        for field in ('translation', 'ai', 'en_tafsir'):
            with self.subTest(field=field):
                hits, _ = index_search('luqman parent', 100, field=field)
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
                self.assertLessEqual(len(refs), searchtool.MMR_CANDIDATE_POOL)
                self.assertEqual(len(refs), len(set(refs)))

    def test_translation_pool_reserves_a_slot_for_missing_stem_terms(self):
        literal = [{'rowid': index, 'surah': 1, 'verse': index}
                   for index in range(1, 51)]
        stem = [{'rowid': 51, 'surah': 2, 'verse': 1}]
        tiers = [('docs', row) for row in literal] + [('stem', row) for row in stem]

        with patch('searchtool._ranked_row_tiers', return_value=tiers):
            rows = searchtool._translation_candidate_rows(
                None, 'alpha beta', {}, None, None, 50)
        self.assertEqual(rows[:5], literal[:5])
        self.assertEqual(len(rows), 50)
        self.assertEqual(len({(row['surah'], row['verse']) for row in rows}), 50)
        self.assertIn(stem[0], rows)

    def test_bypassed_searches_do_not_call_mmr(self):
        with patch('searchtool._mmr_rerank', side_effect=AssertionError('MMR called')):
            index_search('luqman parent', 5, field='ayah')
            index_search('luqman parent', 5, field='bn_tafsir')
            index_search('"luqman parent"', 5, field='all')
            index_search('luqman', 5, field='all')
        with patch('searchtool.SEARCH_MMR_LAMBDA', 1.0), \
                patch('searchtool._mmr_rerank', side_effect=AssertionError('MMR called')):
            index_search('luqman parent', 5, field='all')
            index_search('luqman parent', 5, field='translation')

    def test_english_scopes_use_field_aware_mmr(self):
        for field, query, col in [
                ('all', 'luqman parent', None),
                ('translation', 'luqman parent', 'en_norm'),
                ('ai', 'strongest parental claims', 'ai_norm'),
                ('en_tafsir', 'hardship mujahid said', 'en_tafsir_norm')]:
            with self.subTest(field=field):
                with patch('searchtool._mmr_rerank',
                           wraps=searchtool._mmr_rerank) as rerank, \
                        patch('searchtool._matched_term_masks',
                              wraps=searchtool._matched_term_masks) as masks:
                    hits, _ = index_search(query, 5, field=field)
                self.assertTrue(hits)
                self.assertTrue(rerank.called)
                self.assertTrue(rerank.call_args.kwargs['top5_coverage'])
                self.assertEqual(rerank.call_args.kwargs['preserve_baseline'],
                                 col == 'en_norm')
                self.assertEqual(masks.call_args_list[0].args[3], col)

    def test_luqman_parent_keeps_parent_verse_first(self):
        hits, _ = index_search('Luqman Parent', 5, field='all')
        self.assertEqual(f"{hits[0]['surah']}:{hits[0]['verse']}", '31:14')
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        self.assertEqual(len(refs), len(set(refs)))

    def test_all_fields_preserves_translation_complete_baseline(self):
        with patch('searchtool._mmr_rerank',
                   side_effect=AssertionError('MMR called')):
            hits, _ = index_search('indeed allah lord', 5, field='all')
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        self.assertEqual(refs, ['60:4', '7:54', '14:39', '16:110', '35:34'])

    def test_all_fields_baseline_guard_respects_top5_knob(self):
        with patch('searchtool.SEARCH_TOP5_COVERAGE', False), \
                patch('searchtool._mmr_rerank',
                      wraps=searchtool._mmr_rerank) as rerank:
            index_search('indeed allah lord', 5, field='all')
        self.assertTrue(rerank.called)


class TopFiveCoverageRankingTests(unittest.TestCase):
    def test_uncovered_term_outranks_repeated_partial_match(self):
        rows = [
            {'id': 'luqman-parent'}, {'id': 'luqman-parent-repeat'},
            {'id': 'teaching'}, {'id': 'luqman'}, {'id': 'parent'},
        ]
        words = ['luqman', 'parent', 'teaching']
        masks = [0b011, 0b011, 0b100, 0b001, 0b010]
        normal = searchtool._mmr_rerank(rows, words, masks, 5, 0.7)
        ranked = searchtool._mmr_rerank(rows, words, masks, 5, 0.7, top5_coverage=True)
        self.assertEqual(normal[1]['id'], 'luqman-parent-repeat')
        self.assertEqual(ranked[0]['id'], 'luqman-parent')
        self.assertEqual(ranked[1]['id'], 'teaching')
        covered = 0
        for row in ranked:
            covered |= masks[rows.index(row)]
        self.assertEqual(covered, 0b111)

    def test_synthetic_partial_results_cover_luqman_and_parent(self):
        rows = [
            {'id': 'luqman-1'}, {'id': 'luqman-2'}, {'id': 'luqman-3'},
            {'id': 'luqman-4'}, {'id': 'parent'},
        ]
        masks = [0b01, 0b01, 0b01, 0b01, 0b10]
        ranked = searchtool._mmr_rerank(
            rows, ['luqman', 'parent'], masks, 5, 0.7, top5_coverage=True)
        ids = [row['id'] for row in ranked]
        self.assertIn('parent', ids)
        self.assertTrue(any(ref.startswith('luqman-') for ref in ids))
        self.assertEqual(len(ids), len(set(ids)))

    def test_top5_maximizes_coverage_without_a_full_match(self):
        rows = [
            {'id': 'repeat-1'}, {'id': 'repeat-2'},
            {'id': 'repeat-3'}, {'id': 'repeat-4'},
            {'id': 'novel-1'}, {'id': 'novel-2'},
        ]
        words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
        masks = [0b001111, 0b001111, 0b001111, 0b001111, 0b010000, 0b100000]
        normal = searchtool._mmr_rerank(rows, words, masks, 5, 0.7)
        ranked = searchtool._mmr_rerank(
            rows, words, masks, 5, 0.7, top5_coverage=True)

        def covered(selection):
            union = 0
            for row in selection:
                union |= masks[rows.index(row)]
            return union

        self.assertNotEqual(covered(normal), 0b111111)
        self.assertEqual(covered(ranked), 0b111111)
        self.assertIn('novel-2', [row['id'] for row in ranked])

    def test_best_result_and_all_full_coverage_results_are_preserved(self):
        rows = [
            {'id': 'best'}, {'id': 'full-1'}, {'id': 'full-2'}, {'id': 'partial'},
        ]
        words = ['alpha', 'beta', 'gamma']
        masks = [0b001, 0b111, 0b111, 0b110]
        normal = searchtool._mmr_rerank(rows, words, masks, 4, 0.7)
        ranked = searchtool._mmr_rerank(
            rows, words, masks, 4, 0.7, top5_coverage=True)
        ids = [row['id'] for row in ranked]
        self.assertEqual(ranked[0], normal[0])
        self.assertLess(ids.index('full-1'), ids.index('partial'))
        self.assertLess(ids.index('full-2'), ids.index('partial'))

    def test_low_rank_full_match_precedes_nearly_full_partial(self):
        rows = [{'id': f'row-{index}'} for index in range(50)]
        masks = [0] * 50
        masks[0] = 0b111110
        masks[1] = 0b111101
        masks[49] = 0b111111
        words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
        normal = searchtool._mmr_rerank(rows, words, masks, 5, 0.7)
        ranked = searchtool._mmr_rerank(
            rows, words, masks, 5, 0.7, top5_coverage=True)
        self.assertEqual(normal[1]['id'], 'row-1')
        self.assertEqual(ranked[0], normal[0])
        self.assertEqual(ranked[1]['id'], 'row-49')

    def test_knob_and_search_bypass_are_respected(self):
        with patch('searchtool._mmr_rerank', wraps=searchtool._mmr_rerank) as rerank:
            index_search('luqman parent', 5, field='all')
        self.assertTrue(rerank.call_args.kwargs['top5_coverage'])
        with patch('searchtool.SEARCH_TOP5_COVERAGE', False), \
                patch('searchtool._mmr_rerank', wraps=searchtool._mmr_rerank) as rerank:
            index_search('luqman parent', 5, field='all')
        self.assertFalse(rerank.call_args.kwargs['top5_coverage'])
        with patch('searchtool._mmr_rerank', side_effect=AssertionError('MMR called')):
            index_search('luqman parent', 5, field='ayah')
            index_search('"luqman parent"', 5, field='all')

    def test_real_data_and_limit_edges_are_deterministic(self):
        for limit in (1, 5, 10):
            with self.subTest(limit=limit):
                first, _ = index_search('Luqman Parent', limit, field='all')
                second, _ = index_search('Luqman Parent', limit, field='all')
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in first]
                self.assertEqual(refs, [f"{hit['surah']}:{hit['verse']}" for hit in second])
                self.assertEqual(len(refs), limit)
                self.assertEqual(len(refs), len(set(refs)))
                self.assertEqual(refs[0], '31:14')
                if limit >= 5:
                    self.assertIn('31:13', refs[:5])
                    self.assertIn('31:12', refs[:5])


class FieldAwareCoverageIntegrationTests(unittest.TestCase):
    def test_english_scopes_keep_expected_verses_and_render_only_the_selected_field(self):
        cases = [
            ('translation', 'luqman parent', '31:14', 'Translation'),
            ('translation', 'save one life entire humanity israel', '5:32', 'Translation'),
            ('translation', 'hatred enemies fair judgment righteousness', '5:8', 'Translation'),
            ('translation', 'enter home permission greeting inhabitants', '24:27', 'Translation'),
            ('translation', 'sinners despair hope mercy forgiveness', '39:53', 'Translation'),
            ('ai', 'strongest parental claims', '31:13', 'AI explanation'),
            ('en_tafsir', 'hardship mujahid said', '31:14', 'Tafsir Ibn Kathir'),
        ]
        for field, query, expected, chip in cases:
            with self.subTest(field=field, query=query):
                hits, _ = index_search(query, 5, field=field)
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
                self.assertIn(expected, refs[:5])
                self.assertEqual(len(refs), len(set(refs)))
                item = hits[refs.index(expected)]
                self.assertEqual(item['chips'], [chip])
                for item_field in ('ayah', 'translation', 'ai', 'en_tafsir', 'bn_tafsir'):
                    if item_field != searchtool._CHIP_TO_ITEM[searchtool.FIELD_COLS[field]]:
                        self.assertEqual(item[item_field], '')


class DifficultAllFieldsRegressionTests(unittest.TestCase):
    def test_difficult_paraphrases_keep_expected_verse_in_top_five(self):
        cases = [
            ('dead village century uneaten meal animal bones', '2:259'),
            ('kind leader forgive advice trust', '3:159'),
            ('gossip suspicion eating dead sibling', '49:12'),
            ('save one life entire humanity israel', '5:32'),
            ('hard times patient worship seek support', '2:153'),
            ('god never sleeps throne sky knowledge', '2:255'),
            ('hatred enemies fair judgment righteousness', '5:8'),
            ('fairness kindness family oppression forbidden', '16:90'),
            ('enter home permission greeting inhabitants', '24:27'),
            ('sinners despair hope mercy forgiveness', '39:53'),
            ('tribes ethnicities honor righteousness meet', '49:13'),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                hits, _ = index_search(query, 5, field='all')
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
                self.assertIn(expected, refs)
                self.assertEqual(len(refs), len(set(refs)))


class DifficultTranslationCoverageRegressionTests(unittest.TestCase):
    def test_previous_translation_regressions_stay_in_the_top_five(self):
        cases = [
            ('save one life entire humanity israel', '5:32'),
            ('mother pregnancy hardship thank parents return', '31:14'),
            ('hatred enemies fair judgment righteousness', '5:8'),
            ('enter home permission greeting inhabitants', '24:27'),
            ('sinners despair hope mercy forgiveness', '39:53'),
            ('hard times patient worship seek support', '2:153'),
            ('fairness kindness family oppression forbidden', '16:90'),
            ('tribes ethnicities honor righteousness meet', '49:13'),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                hits, _ = index_search(query, 5, field='translation')
                refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
                self.assertIn(expected, refs)
                self.assertEqual(len(refs), len(set(refs)))


class BenchmarkScopeTests(unittest.TestCase):
    def test_coverage_groups_follow_the_effective_field(self):
        from evaluation.compare_keyword_knobs import group_keys

        case = {'query': 'Luqman Parent', 'intent': 'multi',
                'language': 'en', 'field': 'translation'}
        self.assertIn('coverage_english_multi_translation', group_keys(case))
        overridden = group_keys(case, 'ai')
        self.assertIn('coverage_english_multi_ai', overridden)
        self.assertNotIn('coverage_english_multi_translation', overridden)
        self.assertNotIn('coverage_english_multi_all', overridden)

    def test_coverage_uses_the_same_porter_stems_as_fcs(self):
        from evaluation.compare_keyword_knobs import coverage_at_five, porter_term

        self.assertEqual(porter_term('parents'), 'parent')
        self.assertEqual(porter_term('teachings'), 'teach')
        case = {'query': 'parent teaching', 'intent': 'multi', 'language': 'en'}
        corpus = {'31:14': {'parent', 'teach'}}
        self.assertEqual(coverage_at_five(case, ['31:14'], corpus), 1.0)


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
