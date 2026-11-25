# Run the self-contained PR #2 app

Use CPython 3.12 x64. First obtain the complete checkout, including `git lfs pull`.
Then install the normal application dependencies (requires package-index access):

```text
python deployment/manage.py install
```

On Windows:

```text
.venv/Scripts/python.exe deployment/manage.py build
.venv/Scripts/python.exe deployment/manage.py serve --listen 127.0.0.1:8000
```

On Linux x64 (glibc 2.28+), use `.venv/bin/python` instead.
Runtime-only installation is the default. The separate optional offline kit is only
needed for offline dependency installation or regenerating embeddings.

See [deployment/README.md](deployment/README.md) for production settings, offline
rebuilds, browser verification, supported platforms, and portable ZIP packaging.
