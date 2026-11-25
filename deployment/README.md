# Self-contained search deployment

PR #2 includes the prebuilt translation and all-fields embeddings, their validated
fusion configuration, the quantized browser model/tokenizer, the original builder
checkpoint/tokenizer, Transformers.js, ONNX/WASM, the search UI libraries, and
complete Python wheel sets. Models and wheels use Git LFS.

## Obtain all files

Fetch the PR branch and run `git lfs pull` while connected. GitHub's default source
ZIP can contain LFS pointers instead of weights; use a clone with LFS, or the
expanded ZIP produced below. `deployment/assets.json` records SHA-256 checksums
and byte sizes and detects missing downloads and LFS pointers before installation.
No API key, embedding API, vector database, Hugging Face cache, npm install,
compiler, or model download is needed after the files have been obtained.

Prerequisites supplied by the host are **CPython 3.12 x64 with venv/ensurepip**,
the operating system, and a browser supporting WebAssembly and module workers.
Bundled wheels target Windows x64 and glibc Linux x64 (glibc 2.28 or newer).
macOS, ARM, Alpine/musl, and other Python versions need their own wheel set.
Node.js and Chromium are needed only to reproduce browser verification.

## Install and build without downloads

Run from the checkout root (the manager also resolves the root itself):

```text
python deployment/manage.py verify
python deployment/manage.py install
```

The installer creates `.venv` and uses only bundled wheels, exact version locks,
SHA-256 hashes, `--no-index`, and `--no-cache-dir`. To deploy the prebuilt embeddings
without installing PyTorch/Transformers, use `install --runtime-only` instead.

Use `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Linux for the
following commands (shown with `PYTHON` as a placeholder):

```text
PYTHON deployment/manage.py build
PYTHON -m unittest test_meaning_search.py test_search_ranking.py
PYTHON deployment/manage.py serve --listen 127.0.0.1:8000
```

`build` rebuilds the SQLite search index from the included source databases and
validates every field's precomputed embeddings against those sources. The browser
always loads its model, runtime, and vectors from this app; the old local-model
environment flag is no longer required. A first search still transfers roughly
158 MB from your own server to a new browser.

Use HTTPS in production (or localhost for development). Place Waitress behind
your normal HTTPS reverse proxy, set `AAYATUN_HTTPS=1`, and provision a persistent
`AAYATUN_SECRET_KEY` outside Git. Serve `/static/` directly when possible; `.js`
and `.mjs` need a JavaScript MIME type, `.wasm` needs `application/wasm`, and model
and vector files can use `application/octet-stream`. Keep the app's `db/` runtime
directory writable. No GPU is required.

## Rebuild embeddings from scratch

With the full installation:

```text
PYTHON deployment/manage.py smoke-model
PYTHON deployment/manage.py rebuild-embeddings
```

The smoke test denies socket connections and runs the real local tokenizer,
checkpoint and passage encoder. A full CPU rebuild takes considerably longer.
The manager uses the included pinned checkpoint cache with offline mode enabled.
Rebuilt assets are written to `dist/rebuilt/`; the existing frozen deployment is
preserved. New source content or fusion choices require fresh validation before
replacing the deployed manifest. See `SEMANTIC_SEARCH.md` for validation provenance.

## Verify a question with external DNS blocked

```text
node evaluation/islamqa_pr2_browser.cjs --scope all-fields --allow-working-tree --offline --query "what questions will be asked on the day of judgement" --chrome PATH_TO_CHROMIUM --output deployment/verification/day-of-judgement.json
```

This uses a fresh browser profile and blocks external DNS while allowing loopback.
The report contains actual ranked references, field scores, model and vector hashes,
and locally served assets. `deployment/examples/day-of-judgement.json` records the
observed result for comparison. Similarity scores are not probabilities or a
religious ruling; inspect the referenced verses for relevance.

## Create a portable expanded package

After building, from a committed checkout:

```text
PYTHON deployment/manage.py package
```

`dist/aayatun-offline.zip` contains tracked application files, actual LFS payloads,
both platform wheel sets, and the generated SQLite index/vocabulary. It excludes
secrets, virtual environments, and unrelated research caches. Install the extracted
package with the same commands above. Store and serve large weights securely as
ordinary static files; do not expose the `models/` builder checkpoint directory.

The core search flow and its UI libraries are local. Existing optional services
(Google web fonts, emoji images, recitation audio, prayer services and external
reader content fetched on demand) retain their existing network behavior; this
package does not mirror every third-party content service. Model and Python
dependencies are fully included. Licenses are under `deployment/licenses/` and
inside each wheel. ONNX notices are from the 1.21.0 source release; the shipped
Web runtime is the pinned 1.22.0 development build used by Transformers.js 3.7.2.

## Maintainers

`python deployment/freeze_assets.py` regenerates the platform locks and asset
checksums after an intentional dependency/asset update. Review those changes and
repeat offline installation, builder validation, Flask tests, and browser checks.
