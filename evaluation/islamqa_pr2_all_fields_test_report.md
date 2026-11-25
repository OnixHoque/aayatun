# All-fields semantic search: held-out test report

The fusion configuration was selected on validation only. The test fixture was not used for tuning.

| Run | Relevant Hit@5 (all) | Useful Hit@5 (useful-answerable) | Direct Hit@5 (direct groups) | MRR@10 (all) | NDCG@10 (all) | Recall@5 (all) | Recall@10 (all) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deploy_keyword_translation | 7.0% | 7.8% | 14.8% | 0.0505 | 0.0373 | 3.5% | 4.6% |
| pr1_keyword_translation | 7.2% | 8.2% | 13.0% | 0.0503 | 0.0376 | 3.6% | 4.7% |
| pr1_keyword_all_fields | 15.9% | 16.7% | 14.8% | 0.1086 | 0.0917 | 9.2% | 12.0% |
| pr2_meaning_translation | 13.3% | 15.0% | 27.8% | 0.0900 | 0.0742 | 7.6% | 10.1% |
| semantic_ar_raw | 0.9% | 0.7% | 3.7% | 0.0029 | 0.0015 | 0.1% | 0.1% |
| semantic_en | 13.3% | 15.0% | 27.8% | 0.0900 | 0.0742 | 7.6% | 10.1% |
| semantic_en_tafsir | 15.7% | 17.0% | 29.6% | 0.0990 | 0.0860 | 8.3% | 12.4% |
| semantic_bn_tafsir | 4.3% | 5.1% | 5.6% | 0.0263 | 0.0206 | 2.1% | 2.6% |
| semantic_verse_context | 7.2% | 7.5% | 13.0% | 0.0392 | 0.0253 | 2.8% | 3.4% |
| semantic_word_meanings | 2.3% | 2.7% | 3.7% | 0.0144 | 0.0111 | 0.9% | 1.8% |
| semantic_surah_name | 1.4% | 1.4% | 1.9% | 0.0073 | 0.0049 | 0.3% | 0.8% |
| pr2_meaning_all_fields | 18.8% | 20.7% | 40.7% | 0.1253 | 0.1042 | 9.7% | 14.5% |

## Fused meaning versus PR #1 all-fields keyword

| Metric | Delta | Paired group-bootstrap 95% CI | Wins | Losses | Ties |
| --- | ---: | --- | ---: | ---: | ---: |
| positive_hit@5 | +0.0290 | [-0.0201, +0.0758] | 37 | 27 | 281 |
| useful_hit@5 | +0.0408 | [-0.0137, +0.0915] | 35 | 23 | 236 |
| direct_hit@5 | +0.2593 | [+0.1321, +0.3929] | 15 | 1 | 38 |
| mrr@10 | +0.0167 | [-0.0153, +0.0488] | 60 | 41 | 244 |
| ndcg@10 | +0.0125 | [-0.0087, +0.0341] | 62 | 44 | 239 |

Relevant Hit@5, MRR, NDCG, and recall use all test queries. Useful Hit@5 uses only cases with a settled useful answer; direct Hit@5 uses only direct-answer question groups.

## Verification and cost

- Validation provenance verified: True
- Browser/offline exact agreement: True
- Duplicate browser runs identical: True
- Translation baseline reproduced exactly for 345 queries: True
- Vector assets: 21.92 MB in 7 unique files
- Cold loopback transfer (model plus semantic assets): 157.72 MB in 13 requests
- Warmed browser p50/p95: 190/634 ms

The JSON report contains every standalone field, paired comparison, confidence interval, win/loss count, judgment-coverage count, asset hash, and per-query timing.

The dataset remains provisional, non-blind, model-assisted, and English-only. Cold transfer uses loopback; warmed timings are not production latency.
