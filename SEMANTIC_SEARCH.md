# Meaning-search prototype

The optional service embeds English translations with the pinned multilingual
E5-small model. Flask sends the question to the service, merges the ten vector
candidates with ten translation-keyword candidates using reciprocal rank
fusion, and resolves the results to the existing verse database.

## Local trial

Use a separate Python environment with NumPy, PyTorch and Transformers and
the cached model revision declared in semantic_service.py. The main Flask
environment uses its existing dependencies.

Run from the app checkout.

```text
python semantic_service.py --db db/search.db
```

The service binds to 127.0.0.1 on port 19201. It builds a cached translation
matrix on its first run. The cache records a fingerprint covering the model,
revision and source rows. It regenerates when those inputs change.

Set AAYATUN_SEMANTIC_URL to http://127.0.0.1:19201 in the Flask process
environment, then restart Flask. The search dialog and results form offer
Search by meaning when this setting is present. Keyword search is the default.
Meaning search uses the English translation corpus and returns up to ten
verses. Both services verify the translation corpus hash.

Remove AAYATUN_SEMANTIC_URL and restart Flask to disable the control.
Missing services and incompatible corpora display an error on the results page.

## Validation and deployment

Run python -m unittest test_search_ranking test_meaning_search.
The benchmark checkout includes evaluate_meaning_ui.py for the 62-question
English slice, using the actual service and Flask search route.

This is a local prototype. Before deployment, measure CPU inference, startup,
worker memory, concurrency and latency on the intended infrastructure.
Evaluate a managed service process and an authenticated transport if the
inference service runs on another host. Review timeout and capacity limits
against measured traffic. The loopback HTTP service supports this local trial.

Track hosting and broader relevance evaluation in
[issue 12](https://github.com/Mehrab-Tanjim/aayatun/issues/12).
