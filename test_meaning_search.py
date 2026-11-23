"""Flask coverage for the optional meaning-search service boundary."""
import io
import json
import os
import unittest
from unittest.mock import patch

from app import app


class MeaningSearchTests(unittest.TestCase):
    def test_service_failure_is_visible_and_keyword_search_still_works(self):
        with patch.dict(os.environ, {'AAYATUN_SEMANTIC_URL': 'http://127.0.0.1:19201'}):
            with patch('urllib.request.urlopen', side_effect=OSError('unavailable')):
                response = app.test_client().post('/search/', data={
                    'query_str': 'visitor entering home', 'search_mode': 'meaning'})
                self.assertIn('Meaning search is temporarily unavailable', response.get_data(as_text=True))
            response = app.test_client().post('/search/', data={'query_str': 'light upon light'})
            self.assertIn('24:35', response.get_data(as_text=True))

    def test_stale_corpus_is_rejected(self):
        payload = json.dumps({'refs': ['24:27'], 'corpus': 'stale'}).encode()
        with patch.dict(os.environ, {'AAYATUN_SEMANTIC_URL': 'http://127.0.0.1:19201'}):
            with patch('urllib.request.urlopen', return_value=io.BytesIO(payload)):
                response = app.test_client().post('/search/', data={
                    'query_str': 'visitor entering home', 'search_mode': 'meaning'})
                self.assertIn('index does not match', response.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
