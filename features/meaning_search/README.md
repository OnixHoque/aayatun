# Meaning search

This folder owns the browser worker, prebuilt embeddings and fallback model,
Flask integration, templates, tests, benchmark artifacts, and deployment tools.
Aayatun starts with its usual commands. The Flask blueprint serves this folder’s
public assets under `/static/meaning/` and exposes the feature to the search forms.

- [Deploy, verify and optionally rebuild](deployment/README.md)
- [Ranking and benchmark methodology](SEMANTIC_SEARCH.md)
