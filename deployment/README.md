# Deploy meaning search

## Normal deployment: use the included embeddings

The PR includes precomputed embeddings, the browser ONNX model/tokenizer, the
JavaScript/WASM inference runtime, search UI assets, and the app's source databases.
**Normal deployment does not rebuild embeddings or need PyTorch, Transformers,
Python wheel archives, or the original training-format checkpoint.**

Obtain the branch and its Git LFS runtime files while connected:

```text
git lfs pull
python deployment/manage.py verify
python deployment/manage.py install
```

The installer creates `.venv` and installs the normal Flask/SQLite application
requirements from the Python package index. Python 3.12 is the tested version.
You can instead use an existing environment with `pip install -r requirements.txt`.

Use `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Linux below
(`PYTHON` is a placeholder for that executable):

### Prepare the keyword index and check the supplied embeddings

```text
PYTHON deployment/manage.py build
```

This builds the SQLite keyword-search index and validates the shipped embeddings.
It does not run an embedding model or generate new vectors.

### Start the website

```text
PYTHON -m flask --app app.py run --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. For production use
`PYTHON deployment/manage.py serve --listen 127.0.0.1:8000` (Waitress) behind your
HTTPS reverse proxy. Set `AAYATUN_HTTPS=1` and a persistent `AAYATUN_SECRET_KEY`
outside Git. Serve `/static/` directly where possible; `.mjs` needs JavaScript MIME
and `.wasm` needs `application/wasm`. Keep the runtime `db/` directory writable.

### Browser download and cache

The first uncached search downloads about 180 MB of model, tokenizer, vectors and
runtime from your own server. The page shows a spinner and model download progress.
Query embedding and ranking run on the visitor's device; Flask validates verse
references and renders results. No server GPU, inference API, or vector database
is needed.

Transformers.js stores the model/tokenizer in the browser's `transformers-cache`.
The service worker caches the versioned runtime and hashed vector assets separately
and preserves model caches across app updates. Later searches and page reloads
reuse these files. Clearing site data, private browsing, storage restrictions or
browser eviction can require another download. Cached files still have to be loaded
into a new worker's memory; caching avoids transfer, not all initialization work.

## Optional: offline installation and embedding rebuild kit

These large files are **not required by, or checked into, the normal deployment**:

- Original E5 checkpoint/tokenizer under `models/hub/` (about 493 MB).
- Windows and Linux CPython 3.12 x64 wheel sets under `deployment/wheels/`
  (about 488 MB combined).

Download the [optional offline build kit](https://github.com/Mehrab-Tanjim/aayatun/releases/download/meaning-search-offline-build-v1/aayatun-optional-offline-build.zip)
and its [SHA-256 checksum](https://github.com/Mehrab-Tanjim/aayatun/releases/download/meaning-search-offline-build-v1/aayatun-optional-offline-build.zip.sha256).
Extract it into the checkout root so `models/` and `deployment/wheels/` are present.
These directories are gitignored; production verification does not require them.
The optional wheel set supports Windows x64 and glibc Linux x64 (glibc 2.28+).
Other targets need their own compatible dependencies.

### Install without package-index downloads (optional)

```text
python deployment/manage.py install --offline
```

This uses only the downloaded kit, exact wheel locks and SHA-256 hashes, with
`--no-index --no-cache-dir --require-hashes`.

<a id="rebuild-embeddings-from-scratch"></a>

### Regenerate embeddings (maintainers only; not a deployment step)

Only use this when intentionally changing the source corpus or builder:

```text
python deployment/manage.py install --offline --build-deps
PYTHON deployment/manage.py smoke-model
PYTHON deployment/manage.py rebuild-embeddings
```

The manager selects the optional pinned checkpoint and disables external model
access. The smoke test runs the real encoder with sockets disabled. Full rebuilding
can take considerably longer. New vectors go to `dist/rebuilt/`; they need fresh
validation before deployment. See `SEMANTIC_SEARCH.md` for provenance and tuning.
The known zero-based AI verse-mapping issue remains unresolved in the ranked index;
the results page shows correctly aligned per-verse AI context separately.

## Verification and portable packaging

```text
PYTHON -m unittest test_meaning_search.py test_search_ranking.py
PYTHON deployment/manage.py package
```

`dist/aayatun-runtime.zip` contains the application, actual runtime LFS files and
any built SQLite index/vocabulary. It excludes the optional checkpoint/wheels,
virtual environments and secrets. GitHub's default source ZIP may contain LFS
pointers instead of model payloads.

To reproduce the actual UI and model-cache check with Node.js and Chromium, set
`AAYATUN_CHROME` to your Chromium executable, run the website on port 8000, and run
`node evaluation/meaning_ui_browser.cjs`.

Existing optional web fonts, emoji images, recitation/prayer services and on-demand
external reader content retain their existing network behavior. Licenses are under
`deployment/licenses/` and inside optional wheels. No embedding model API key is
required. Windows execution is tested; Linux wheels resolve but Linux runtime
execution has not been tested here.

Maintainers: `python deployment/freeze_assets.py` records required runtime/data
checksums and refreshes optional wheel locks if the optional kit is present.
`PYTHON deployment/manage.py package --optional` creates a separate offline kit.
