"""Verify browser-ranked results and the existing keyword route."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from app import app
from features import meaning_search as integration
from . import meaning_search

ASSETS = meaning_search.ASSET_ROOT


class MeaningSearchTests(unittest.TestCase):
    def test_feature_assets_keep_their_public_urls_and_package_files_stay_private(self):
        client = app.test_client()
        page = client.get('/').get_data(as_text=True)
        self.assertIn('/static/meaning/js/meaning-search.js?v=8', page)
        for asset in ('index.json', 'js/meaning-worker.js'):
            with client.get('/static/meaning/' + asset) as response:
                self.assertEqual(response.status_code, 200)
        self.assertEqual(client.get('/static/meaning/../meaning_search.py').status_code, 404)
        self.assertEqual(client.get('/features/meaning_search/deployment/assets.json').status_code, 404)

    def test_only_ready_scopes_appear_in_the_form(self):
        with patch.object(integration, '_available', side_effect=lambda scope: scope == 'translation'):
            page = app.test_client().get('/').get_data(as_text=True)
        self.assertIn('value="translation" selected', page)
        self.assertNotIn('value="all-fields"', page)
        with patch.object(integration, '_available', return_value=False):
            page = app.test_client().get('/').get_data(as_text=True)
        self.assertNotIn('id="dialog-search-mode"', page)
        self.assertNotIn('/static/meaning/js/meaning-search.js', page)

    def test_all_fields_results_include_tafsir_and_correctly_aligned_ai_context(self):
        import sqlite3
        manifest = json.loads((ASSETS / "all-fields-index.json").read_text(encoding='utf8'))
        results, meta = meaning_search.search(['75:6'], manifest['corpus'], scope='all-fields')
        self.assertIsNone(meta['error'])
        with sqlite3.connect('db/ai_context.db') as conn:
            expected = json.loads(conn.execute(
                'SELECT content FROM verse_analysis WHERE surah=75 AND verse=5').fetchone()[0])['verse_context']
            wrong = json.loads(conn.execute(
                'SELECT content FROM verse_analysis WHERE surah=75 AND verse=6').fetchone()[0])['verse_context']
        self.assertEqual(results[0]['semantic_ai'], expected)
        self.assertNotEqual(results[0]['semantic_ai'], wrong)
        self.assertIn('denying its occurrence', results[0]['semantic_tafsir'])

    def test_verses_render_in_browser_order_without_keyword_search(self):
        manifest = json.loads((ASSETS / "index.json").read_text(encoding="utf8"))
        with patch("searchtool.index_search", side_effect=AssertionError("keyword ranking called")):
            response = app.test_client().post("/search/", data={
                "query_str": "How should I enter someone else's home?",
                "search_mode": "meaning", "meaning_corpus": manifest["corpus"],
                "meaning_ref": ["24:27", "17:23"],
            })
        self.assertEqual(response.status_code, 200)
        refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
        self.assertEqual(refs, ["24:27", "17:23"])

    def test_all_fields_scope_renders_and_explains_its_assets(self):
        manifest = json.loads((ASSETS / "all-fields-index.json").read_text(encoding="utf8"))
        with patch("searchtool.index_search", side_effect=AssertionError("keyword ranking called")):
            response = app.test_client().post("/search/", data={
                "query_str": "patience through hardship", "search_mode": "meaning",
                "meaning_scope": "all-fields", "meaning_corpus": manifest["corpus"],
                "meaning_ref": ["2:153", "94:6"],
            })
        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', text)
        self.assertEqual(refs, ["2:153", "94:6"])
        self.assertGreaterEqual(text.count('value="all-fields" selected'), 2)
        self.assertIn("Tafsir Ibn Kathir", text)
        self.assertIn("AI explanation", text)

    def test_translation_scope_keeps_translation_metadata_on_the_result_form(self):
        manifest = json.loads((ASSETS / "index.json").read_text(encoding="utf8"))
        response = app.test_client().post("/search/", data={
            "query_str": "light", "search_mode": "meaning", "meaning_scope": "translation",
            "meaning_corpus": manifest["corpus"], "meaning_ref": ["24:35"],
        })
        text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        result_source = re.search(r'id="result-search-mode-source".*?</select>', text, re.S)
        self.assertIsNotNone(result_source)
        self.assertIn('value="translation" selected', result_source[0])
        self.assertNotIn('value="all-fields" selected', result_source[0])

    def test_pending_all_fields_scope_is_hidden_and_rejected(self):
        pending = {"scope": "all-fields", "schema_version": 2, "fusion": {"status": "pending_validation"}}
        with patch("pathlib.Path.read_text", return_value=json.dumps(pending)):
            self.assertFalse(integration._manifest_available("all-fields", (1, 2, 3)))
        with patch.object(meaning_search, "_frozen_all_fields_manifest", return_value=None):
            results, meta = meaning_search.search(["1:1"], "unvalidated", scope="all-fields")
        self.assertEqual(results, [])
        self.assertIn("needs refreshing", meta["error"])

    def test_stale_search_display_content_is_rejected(self):
        rows = [
            {"surah": 1, "verse": 1, "ar_raw": "arabic", "en": "english", "surah_name": "Al-Fatiha"},
            {"surah": 1, "verse": 2, "ar_raw": "arabic2", "en": "english2", "surah_name": "Al-Fatiha"},
        ]
        indexed = [(1, 1, 1, "arabic", "english", "Al-Fatiha"),
                   (1, 2, 2, "arabic2", "english2", "Al-Fatiha")]
        self.assertTrue(meaning_search._search_display_matches(rows, indexed, expected_count=2))
        indexed[0] = (1, 1, 1, "arabic", "stale", "Al-Fatiha")
        self.assertFalse(meaning_search._search_display_matches(rows, indexed, expected_count=2))

    def test_frozen_validation_provenance_rejects_tampering(self):
        from .evaluation.islamqa_pr2_all_fields import verify_frozen_validation

        validation = {
            "fixture_sha256": "fixture", "diagnostics_sha256": "diagnostics",
            "duplicate_diagnostics": {"file": "b.json", "sha256": "duplicate"},
            "score_cache_fingerprint": "cache",
            "selected": {"method": "weighted_raw", "weights": {"en": 1.0}},
            "guardrail": {"pass": True},
        }
        index = {"fusion": {"status": "frozen", "method": "weighted_raw",
                              "weights": {"en": 1.0}, "validation": validation}}
        report = {
            "purpose": "validation_model_selection_only", "split": "validation",
            "fixture_manifest": {"split": "validation"},
            "duplicate_validation_runs_identical": True,
            "browser_offline_agreement": {"exact": True},
            "selected": validation["selected"], "fixture_sha256": "fixture",
            "diagnostics_sha256": "diagnostics",
            "duplicate_diagnostics": validation["duplicate_diagnostics"],
            "score_cache": {"fingerprint": "cache"},
            "selection": {"guardrail": {"pass": True}},
        }
        with tempfile.TemporaryDirectory() as directory:
            index_path = Path(directory) / "index.json"
            report_path = Path(directory) / "validation.json"
            index_path.write_text(json.dumps(index), encoding="utf8")
            report["index_sha256_after_freeze"] = hashlib.sha256(index_path.read_bytes()).hexdigest()
            report_path.write_text(json.dumps(report), encoding="utf8")
            self.assertTrue(verify_frozen_validation(index, index_path, report_path)["verified"])
            report["selected"]["weights"]["en"] = 0.5
            report_path.write_text(json.dumps(report), encoding="utf8")
            with self.assertRaisesRegex(ValueError, "validation report"):
                verify_frozen_validation(index, index_path, report_path)

    def test_every_raw_field_participates_in_the_all_fields_hash(self):
        rows = meaning_search.load_rows()
        baseline = meaning_search.all_fields_hash(rows)
        translation = meaning_search.field_hash(rows, "en")
        for field in meaning_search.ALL_FIELDS:
            changed = [dict(row) for row in rows]
            changed[0][field] += " changed"
            self.assertNotEqual(meaning_search.all_fields_hash(changed), baseline, field)
        self.assertEqual(meaning_search.field_hash(rows, "en"), translation)

    def test_all_fields_rejects_a_translation_only_hash_and_unknown_scope(self):
        translation = json.loads((ASSETS / "index.json").read_text(encoding="utf8"))
        client = app.test_client()
        response = client.post("/search/", data={
            "query_str": "light", "search_mode": "meaning", "meaning_scope": "all-fields",
            "meaning_corpus": translation["corpus"], "meaning_ref": ["24:35"],
        })
        self.assertIn("meaning-search index needs refreshing", response.get_data(as_text=True))
        response = client.post("/search/", data={
            "query_str": "light", "search_mode": "meaning", "meaning_scope": "unknown",
            "meaning_corpus": translation["corpus"], "meaning_ref": ["24:35"],
        })
        self.assertIn("Unknown meaning-search scope", response.get_data(as_text=True))

    def test_token_chunk_maps_are_deterministic_and_overlap(self):
        from . import build_meaning_index as builder

        class CharacterTokenizer:
            def __call__(self, text, **options):
                return {
                    "input_ids": list(range(len(text))),
                    "offset_mapping": [(index, index + 1) for index in range(len(text))],
                }

        with patch.object(builder, "OVERLAP_TOKENS", 2):
            first = builder.chunk_text(CharacterTokenizer(), "abcdefghij", limit=4)
            second = builder.chunk_text(CharacterTokenizer(), "abcdefghij", limit=4)
        self.assertEqual(first, ["abcd", "cdef", "efgh", "ghij"])
        self.assertEqual(first, second)

    def test_repeated_surah_names_keep_a_passage_for_every_ayah(self):
        from . import build_meaning_index as builder

        class CharacterTokenizer:
            def __call__(self, text, **options):
                return {
                    "input_ids": list(range(len(text))),
                    "offset_mapping": [(index, index + 1) for index in range(len(text))],
                }

        rows = [{"surah_name": "Al-Fatiha"}, {"surah_name": "Al-Fatiha"}]
        with patch.object(builder, "content_token_limit", return_value=32):
            passages = builder.make_passages(CharacterTokenizer(), rows, "surah_name")
        self.assertEqual([passage[0] for passage in passages], [0, 1])
        self.assertEqual([passage[1] for passage in passages], ["Al-Fatiha", "Al-Fatiha"])

    def test_manifest_rejects_invalid_fusion_weights(self):
        from . import build_meaning_index as builder

        path = (ASSETS / "all-fields-index.json")
        manifest = json.loads(path.read_text(encoding="utf8"))
        manifest["fusion"]["weights"]["en"] = 0.9
        with self.assertRaisesRegex(ValueError, "fusion configuration"):
            builder.validate_manifest(manifest, None, path.parent)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for worker fusion tests")
    def test_worker_fusion_renormalizes_missing_fields_and_breaks_ties_canonically(self):
        core = (ASSETS / "js/meaning-core.mjs").resolve().as_uri()
        script = f"""
            import {{ fuseScores, orderedWeights, rankScores, validateWeights }} from {json.dumps(core)};
            const assert = (condition, message) => {{ if (!condition) throw new Error(message); }};
            const fields = [new Float64Array([1, -Infinity]), new Float64Array([-Infinity, 2])];
            const fused = fuseScores(fields, {{a: 0.25, b: 0.75}}, 'weighted_raw');
            assert(fused[0] === 1 && fused[1] === 2, 'missing-field weights were not renormalized');
            const z = fuseScores(fields, {{a: 0.25, b: 0.75}}, 'weighted_z');
            assert(Number.isFinite(z[0]) && Number.isFinite(z[1]), 'z-score fusion lost a present field');
            assert(rankScores(['1:1', '1:2'], new Float64Array([3, 3]))[0].ref === '1:1', 'tie was not canonical');
            const ordered = orderedWeights([{{name: 'a'}}, {{name: 'b'}}],
                {{method: 'weighted_raw', weights: {{b: 0.75, a: 0.25}}}});
            assert(ordered.a === 0.25 && ordered.b === 0.75, 'fusion configuration weights were not ordered');
            let rejected = false;
            try {{ validateWeights({{a: 0.2, b: 0.2}}); }} catch {{ rejected = true; }}
            assert(rejected, 'weights not summing to one were accepted');
        """
        subprocess.run(["node", "--input-type=module", "-e", script], check=True, cwd=Path.cwd())

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for fusion parity tests")
    def test_offline_fusion_exactly_matches_the_javascript_scoring_core(self):
        import numpy as np
        from .evaluation.islamqa_pr2_all_fields import fuse

        raw = np.asarray([
            [[1.0, 2.0, -np.inf, -np.inf], [0.0, 2.0, 4.0, -np.inf]],
            [[0.1, 0.2, 0.3, -np.inf], [-np.inf, 1.0, 2.0, 3.0]],
        ], dtype=np.float64)
        weights = np.asarray([0.25, 0.75], dtype=np.float64)
        core = (ASSETS / "js/meaning-core.mjs").resolve().as_uri()
        for method in ("weighted_raw", "weighted_z"):
            expected = fuse(raw, weights, method)
            script = f"""
                import {{ fuseScores }} from {json.dumps(core)};
                const raw = {json.dumps(raw.tolist())};
                const fields = raw.map(query => query.map(scores =>
                    Float64Array.from(scores.map(score => score === null ? -Infinity : score))));
                const fused = fields.map(query => Array.from(fuseScores(
                    query, {{a: 0.25, b: 0.75}}, {json.dumps(method)})));
                console.log(JSON.stringify(fused.map(row => row.map(score =>
                    Number.isFinite(score) ? score : null))));
            """
            output = subprocess.check_output(
                ["node", "--input-type=module", "-e", script], cwd=Path.cwd(), text=True
            )
            actual = json.loads(output)
            expected_rows = [
                [float(value) if np.isfinite(value) else None for value in row]
                for row in expected
            ]
            self.assertEqual(actual, expected_rows, method)

    def test_stale_corpus_has_an_error_and_keyword_search_still_works(self):
        client = app.test_client()
        response = client.post("/search/", data={
            "query_str": "visitor entering home", "search_mode": "meaning",
            "meaning_corpus": "stale", "meaning_ref": ["24:27"],
        })
        self.assertIn("meaning-search index needs refreshing", response.get_data(as_text=True))
        response = client.post("/search/", data={"query_str": "light upon light"})
        self.assertIn("24:35", response.get_data(as_text=True))
