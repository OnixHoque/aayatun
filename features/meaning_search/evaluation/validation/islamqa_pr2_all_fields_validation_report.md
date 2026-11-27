# All-fields semantic search: validation tuning report

This report is for model selection only. It contains no held-out test scores.

- Fixture: `islamqa_pr2_validation_queries.jsonl` (260 queries, 257 question groups)
- Duplicate validation runs identical: True
- Browser/offline exact agreement: True
- Evaluated configurations: 828

## Selected fusion

- Method: `weighted_raw`
- Useful-answerable Hit@5: 27.6%
- All-query relevant Hit@5: 25.0%
- All-query NDCG@10: 0.1342
- Direct-answer Hit@5: 25.0% (translation-only 12.5%; guardrail passed: True)

| Field | Weight |
| --- | ---: |
| ar_raw | 0.0 |
| en | 0.2 |
| en_tafsir | 0.6 |
| bn_tafsir | 0.0 |
| verse_context | 0.2 |
| word_meanings | 0.0 |
| surah_name | 0.0 |

## Standalone semantic fields

| Field | Relevant Hit@5 (all) | Useful Hit@5 (useful-answerable) | Direct Hit@5 (direct groups) | MRR@10 (all) | NDCG@10 (all) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ar_raw | 1.2% | 0.9% | 2.5% | 0.0073 | 0.0044 |
| en | 13.1% | 14.5% | 12.5% | 0.0919 | 0.0801 |
| en_tafsir | 16.9% | 19.9% | 12.5% | 0.1248 | 0.1031 |
| bn_tafsir | 4.2% | 5.0% | 10.0% | 0.0252 | 0.0127 |
| verse_context | 8.5% | 8.6% | 10.0% | 0.0530 | 0.0338 |
| word_meanings | 2.3% | 2.7% | 5.0% | 0.0167 | 0.0089 |
| surah_name | 1.2% | 1.4% | 2.5% | 0.0100 | 0.0064 |

Weights use 0.1 steps and greedy pairwise coordinate transfers. Selection order is useful-answerable Hit@5, all-query relevant Hit@5, then all-query NDCG@10. The direct-answer guardrail may not drop more than two percentage points below translation-only meaning search.

Validation labels are provisional, model-assisted, non-blind, and English-only.
