"""Optional E5 translation retrieval service. Run in a separate inference environment."""
import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
import threading
import tempfile


MODEL = 'intfloat/multilingual-e5-small'
REVISION = 'c007d7ef6fd86656326059b28395a7a03a7c5846'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('db/search.db'))
    parser.add_argument('--port', type=int, default=19201)
    parser.add_argument('--cache', type=Path, default=Path('db/translation_vectors.npz'))
    args = parser.parse_args()
    # Inference dependencies belong to this service's environment.
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION, local_files_only=True)
    model = AutoModel.from_pretrained(MODEL, revision=REVISION, local_files_only=True).eval().to(device)

    @torch.inference_mode()
    def encode(texts):
        batches = []
        for start in range(0, len(texts), 32):
            inputs = tokenizer(texts[start:start + 32], padding=True, truncation=True,
                               max_length=512, return_tensors='pt').to(device)
            hidden = model(**inputs).last_hidden_state.float()
            mask = inputs.attention_mask.unsqueeze(-1)
            pooled = (hidden * mask).sum(1) / mask.sum(1)
            batches.append(torch.nn.functional.normalize(pooled).cpu().numpy())
        return np.concatenate(batches)

    conn = sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        rows = conn.execute('SELECT surah, verse, en FROM docs ORDER BY surah, verse').fetchall()
    finally:
        conn.close()
    refs = [f'{s}:{v}' for s, v, _ in rows]
    corpus_hash = hashlib.sha256(json.dumps(
        {f'{s}:{v}': text for s, v, text in rows}, sort_keys=True).encode()).hexdigest()
    fingerprint = hashlib.sha256(json.dumps([MODEL, REVISION, rows]).encode()).hexdigest()
    vectors = None
    if args.cache.is_file():
        with np.load(args.cache, allow_pickle=False) as cache:
            if str(cache['fingerprint']) == fingerprint:
                vectors = cache['vectors']
    if vectors is None:
        vectors = encode(['passage: ' + text for _, _, text in rows])
        # Serving begins only after this process has a complete in-memory index.
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=args.cache.parent) as directory:
            temporary = Path(directory) / 'vectors.npz'
            np.savez_compressed(temporary, fingerprint=fingerprint, vectors=vectors)
            temporary.replace(args.cache)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != '/search':
                self.send_error(404)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8192:
                    raise ValueError('request size')
                request = json.loads(self.rfile.read(length))
                query = request['query']
                if not isinstance(query, str) or not query.strip() or len(query) > 1000:
                    raise ValueError('query')
                with lock:
                    query_vector = encode(['query: ' + query])[0]
                    top = np.argsort(-(vectors @ query_vector), kind='stable')[:10]
                response = json.dumps({'refs': [refs[i] for i in top],
                                       'corpus': corpus_hash}).encode()
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    print(f'Ready on 127.0.0.1:{args.port}; {len(refs)} translations; {device}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
