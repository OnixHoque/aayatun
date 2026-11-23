"""Verify browser-ranked results and the existing keyword route."""
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from app import app


class MeaningSearchTests(unittest.TestCase):
    def test_verses_render_in_browser_order_without_keyword_search(self):
        manifest = json.loads(Path("static/meaning/index.json").read_text(encoding="utf8"))
        with patch("searchtool.index_search", side_effect=AssertionError("keyword ranking called")):
            response = app.test_client().post("/search/", data={
                "query_str": "How should I enter someone else's home?",
                "search_mode": "meaning", "meaning_corpus": manifest["corpus"],
                "meaning_ref": ["24:27", "17:23"],
            })
        self.assertEqual(response.status_code, 200)
        refs = re.findall(r'class="surahlink"[^>]*>\s*(\d+:\d+)', response.get_data(as_text=True))
        self.assertEqual(refs, ["24:27", "17:23"])

    def test_stale_corpus_has_an_error_and_keyword_search_still_works(self):
        client = app.test_client()
        response = client.post("/search/", data={
            "query_str": "visitor entering home", "search_mode": "meaning",
            "meaning_corpus": "stale", "meaning_ref": ["24:27"],
        })
        self.assertIn("meaning-search index needs refreshing", response.get_data(as_text=True))
        response = client.post("/search/", data={"query_str": "light upon light"})
        self.assertIn("24:35", response.get_data(as_text=True))
