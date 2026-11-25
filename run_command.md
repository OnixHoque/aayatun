# Run the self-contained PR #2 app

Use CPython 3.12 x64. First obtain the complete checkout, including `git lfs pull`.
Then the following installation uses only the included files:

```text
python deployment/manage.py install
```

On Windows:

```text
.venv/Scripts/python.exe deployment/manage.py build
.venv/Scripts/python.exe deployment/manage.py serve --listen 127.0.0.1:8000
```

On Linux x64 (glibc 2.28+), use `.venv/bin/python` instead.
`install --runtime-only` skips the embedding rebuild dependencies when using the
included prebuilt vectors. Use `python deployment/manage.py verify` to check all
assets, including the models and both platform wheel sets.

See [deployment/README.md](deployment/README.md) for production settings, offline
rebuilds, browser verification, supported platforms, and portable ZIP packaging.
