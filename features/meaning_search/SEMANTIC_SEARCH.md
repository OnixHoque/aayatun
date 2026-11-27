# Search by meaning

Readers choose **Search by meaning** in the search dialog or on the results page. A browser worker embeds the question once with multilingual E5-small, scores independent field indexes, and returns up to ten unique ayat. Flask validates the selected references and renders the normal Arabic-verse and English-translation results.

When `features/meaning_search/static/all-fields-index.json` contains a validated frozen configuration, it is the default meaning-search scope. The original translation-only `features/meaning_search/static/index.json` remains available for compatibility and for the reproducible PR #2 baseline. A newly rebuilt all-fields manifest starts as `pending_validation`; Flask and the server-side validator hide and reject that scope until validation tuning freezes it.

## Searched fields

The all-fields scope indexes these fields independently:

- Arabic ayah text (`ar_raw`)
- English translation (`en`)
- English tafsir (`en_tafsir`)
- Bengali tafsir (`bn_tafsir`)
- AI verse explanation/context (`verse_context`)
- AI word meanings, including Arabic words and their English explanations (`word_meanings`)
- Surah names (`surah_name`)

The AI field is explanation/context, not a new AI translation. Bare Arabic roots remain available through keyword `root:` search.

Long fields are split into deterministic 512-token passages with 64-token overlap. The score for an ayah and field is the maximum cosine similarity across that ayah's passages. Missing field text is excluded, and the remaining field weights are renormalized for that ayah. Exact ties use canonical ayah order.

## Fusion

Two fusion methods are implemented:

- `weighted_raw`: \(\sum_f w_f \cos(v,q,f)\)
- `weighted_z`: \(\sum_f w_f z_f(v,q)\)

Weights are nonnegative and sum to one. The deployed method and weights are selected on the validation split only, then frozen before the held-out test run. The browser worker and offline evaluator use the same scoring helpers and agree exactly on references and rounded scores for the frozen configuration.

## Deploy

Flask exposes `features/meaning_search/static/` at `/static/meaning/`. The all-fields vectors contain 57,090 passages and 21.92 MB of int8 data, plus the manifest and passage maps. The original translation-only vectors are reused unchanged when their corpus and model hashes match. The all-fields worker verifies each downloaded vector file against its manifest SHA-256 hash.

Flask runs no model and needs no inference service or API key. It verifies the current searchable corpus, rejects stale or unknown references, and falls back cleanly when an index is incomplete. The browser loads the pinned Transformers.js 3.7.2 runtime and ONNX/WASM from the app itself. Model/tokenizer files are fetched from the pinned Hugging Face revision first, with the bundled server snapshot as fallback. Browser cache keys stay on the app origin so either source is reused. The first use transfers about 140 MB for the model and can take longer on slow connections or devices.

These files are included under `features/meaning_search/static/models/Xenova/multilingual-e5-small/` (the large ONNX file uses Git LFS):

- `config.json`
- `tokenizer_config.json`
- `tokenizer.json`
- `onnx/model_int8.onnx`

Hugging Face downloads with local-server fallback are the default; no environment flag is needed. The service worker caches versioned runtime files and hashed vectors on demand. The model is published under the [upstream MIT license](https://huggingface.co/intfloat/multilingual-e5-small). The original checkpoint and offline Python wheels are available as a separate optional build kit. Follow [the deployment guide](deployment/README.md) for the app’s usual setup and the optional offline rebuild workflow.

Pinned model revisions:

- Runtime: `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`
- Offline builder: `intfloat/multilingual-e5-small@c007d7ef6fd86656326059b28395a7a03a7c5846`

## Rebuild the embeddings

The deployment manager selects the bundled checkpoint cache and enables Hugging Face offline mode. After the full offline installation, use the virtual environment's Python:

```bash
python features/meaning_search/deployment/manage.py build
python features/meaning_search/deployment/manage.py smoke-model
python features/meaning_search/deployment/manage.py rebuild-embeddings
```

The builder checks all 6,236 canonical references, vector and passage-map lengths, nonzero norms, source hashes, field hashes, missing-field coverage, model metadata, and asset totals before publishing the manifest. It also refuses to publish if a source file changes during the build. The manager writes fresh embeddings to `features/meaning_search/dist/rebuilt/` to preserve the validated deployment. Publish the manifest and all referenced vector files together after validation.

A rebuild produces `pending_validation` defaults. Do not manually mark them frozen. Generate validation diagnostics and run the tuning command below; the evaluator records validation provenance and freezes the selected configuration atomically.

## Reproduce the benchmark

Run these commands from the repository root. The retained reports and index
provenance describe the pre-refactor benchmark. The feature move did not rebuild
the vectors or rerun fusion tuning.

The evaluator uses the provisional IslamQA v2 package. Validation contains 257 question groups and 260 English wordings; test contains 341 groups and 345 wordings. Labels are model-assisted, non-blind, and not benchmark-grade.

Prepare the validation fixture and the pinned PR #1 all-fields lexical baseline:

```bash
python -m features.meaning_search.evaluation.islamqa_pr2 prepare --split validation
python -m features.meaning_search.evaluation.islamqa_pr2 lexical --field all \
  --output features/meaning_search/evaluation/islamqa_pr2_fcs_all_fields_rankings.json
```

Run the production worker twice against validation. The diagnostics contain exact query embeddings, per-field top-ten rankings, fused rankings, asset hashes, and timings:

```bash
node features/meaning_search/evaluation/islamqa_pr2_browser.cjs --scope all-fields --allow-working-tree --offline \
  --fixture features/meaning_search/evaluation/validation/islamqa_pr2_validation_queries.jsonl \
  --manifest features/meaning_search/evaluation/validation/islamqa_pr2_validation_fixture_manifest.json \
  --output features/meaning_search/evaluation/validation/islamqa_pr2_all_fields_browser.json

node features/meaning_search/evaluation/islamqa_pr2_browser.cjs --scope all-fields --allow-working-tree --offline \
  --fixture features/meaning_search/evaluation/validation/islamqa_pr2_validation_queries.jsonl \
  --manifest features/meaning_search/evaluation/validation/islamqa_pr2_validation_fixture_manifest.json \
  --output features/meaning_search/evaluation/validation/islamqa_pr2_all_fields_browser_b.json
```

Tune with 0.1 weight steps and greedy coordinate search, then freeze only after the duplicate validation runs and browser/offline parity checks pass:

```bash
python -m features.meaning_search.evaluation.islamqa_pr2_all_fields tune --freeze --bootstrap 2000
python -m features.meaning_search.build_meaning_index --validate-only
```

Run the held-out test twice with the frozen configuration, then generate its report:

```bash
node features/meaning_search/evaluation/islamqa_pr2_browser.cjs --scope all-fields --allow-working-tree --offline \
  --output features/meaning_search/evaluation/islamqa_pr2_all_fields_browser_a.json

node features/meaning_search/evaluation/islamqa_pr2_browser.cjs --scope all-fields --allow-working-tree --offline \
  --output features/meaning_search/evaluation/islamqa_pr2_all_fields_browser_b.json

python -m features.meaning_search.evaluation.islamqa_pr2_all_fields report --bootstrap 2000
```

The final report requires a frozen manifest whose hashes and selected configuration match the validation report. Separate validation and test reports prevent model-selection results from being confused with held-out results.

Reports:

- `evaluation/validation/islamqa_pr2_all_fields_validation_report.md`
- `evaluation/islamqa_pr2_all_fields_test_report.md`
- `evaluation/islamqa_pr2_all_fields_test_rankings.jsonl`

The comparison includes deploy keyword, PR #1 translation keyword, PR #1 all-fields keyword, PR #2 translation meaning, each semantic field alone, and all-fields fused meaning. It reports Hit@5, MRR@10, NDCG@10, recall, paired question-group bootstrap intervals, wins/losses, judgment coverage, asset size, and warmed latency.

## Measured held-out result

The frozen validation selection is `weighted_raw` with English tafsir `0.6`, English translation `0.2`, and AI verse context `0.2`; all other weights are zero.

On the 345-query held-out test, fused all-fields meaning search reached:

- Relevant Hit@5: **18.8%**, versus 13.3% for translation-only meaning and 15.9% for PR #1 all-fields keyword.
- Useful Hit@5 on useful-answerable cases: **20.7%**, versus 15.0% and 16.7% respectively.
- Direct-answer Hit@5: **40.7%**, versus 27.8% and 14.8% respectively.
- MRR@10: **0.1253**, versus 0.0900 and 0.1086.
- NDCG@10: **0.1042**, versus 0.0742 and 0.0917.

The fused-versus-PR #1 relevant Hit@5 delta is +2.9 percentage points, but its paired group-bootstrap 95% interval is [-2.0, +7.6] points. The useful Hit@5 delta is +4.1 points with interval [-1.4, +9.2]. The direct-answer delta is +25.9 points with interval [+13.2, +39.3]. The point estimates therefore favor all-fields fusion, while the broader relevance improvements are not statistically conclusive in this provisional sample.

Measured cost is 21.92 MB of int8 vectors. A fresh Chromium run transferred 157.72 MB including the local model and semantic assets in 13 loopback requests. Warmed all-fields browser latency was p50 190 ms and p95 634 ms, excluding the first query; these are local measurements, not production latency.

## Verification and limitations

Run the application tests with:

```bash
python -m unittest features.meaning_search.test_meaning_search test_search_ranking
```

The all-fields translation field must reproduce all 345 existing PR #2 translation rankings exactly. Two complete builds must produce identical manifest and vector hashes, and duplicate browser runs must produce identical rankings. Browser/offline agreement is required for the frozen configuration.

The two definitive builds were identical: pending manifest SHA-256 `f34405f69a24d8fbc392df15b9b791b9113e3bac3a155dbae36d2c692ff17475`, with all seven vector hashes unchanged. After validation provenance was frozen on the second build, the deployed manifest SHA-256 was `fd109a88f98322abe0fb2b534ba89a2459a64fcffb64962b5c948e1e74b48ea5`.

Results establish English-query quality only. They do not establish Arabic or Bengali query quality. AI explanations and word meanings are generated content, and Bengali tafsir or surah-name weights may legitimately be zero after validation. Incomplete pooled judgments and the non-blind test split limit conclusions.
