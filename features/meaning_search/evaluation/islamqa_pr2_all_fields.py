"""Offline scoring, validation-only fusion tuning, and held-out all-fields reports."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
from typing import Any, Iterable

import numpy as np

from .islamqa_pr2 import (
    BASELINE_REVISION,
    DEPLOY_NAME,
    DEPLOY_REVISION,
    FCS_NAME,
    HERE,
    LEXICAL_BLOBS,
    MANIFEST_NAME,
    MEANING_ASSET_SHA256,
    MEANING_NAME,
    PR_REVISION,
    coverage,
    file_sha256,
    load_fixture,
    package_modules,
    read_jsonl,
    text_sha256,
    validate_rankings,
    verify_package_files,
    write_json,
    write_jsonl,
)

ASSET_ROOT = HERE.parent / "static"
DEFAULT_INDEX = ASSET_ROOT / "all-fields-index.json"
FIELD_NAMES = (
    "ar_raw", "en", "en_tafsir", "bn_tafsir",
    "verse_context", "word_meanings", "surah_name",
)
METRICS = (
    "positive_hit@5", "useful_hit@5", "direct_hit@5",
    "mrr@10", "ndcg@10", "recall@5", "recall@10",
)
DEFAULT_PACKAGE = (
    HERE.parents[3] / "Daleel" / "daleel-islamqa-review" / "datasets"
    / "sanitized_islamqa" / "split_package"
)


def round_scores(values: np.ndarray) -> np.ndarray:
    scaled = np.abs(values) * 1e12
    return np.copysign(np.floor(scaled + 0.5) / 1e12, values)


def round_score(value: float) -> float:
    return math.copysign(math.floor(abs(value) * 1e12 + 0.5) / 1e12, value)


def z_scores(values: np.ndarray) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=np.float64)
    for query in range(values.shape[0]):
        for field in range(values.shape[1]):
            scores = values[query, field]
            count = 0
            total = 0.0
            for score in scores:
                if math.isfinite(score):
                    count += 1
                    total += float(score)
            if not count:
                continue
            mean = total / count
            variance = 0.0
            for score in scores:
                if math.isfinite(score):
                    variance += (float(score) - mean) ** 2
            deviation = math.sqrt(variance / count)
            for ayah, score in enumerate(scores):
                if math.isfinite(score):
                    result[query, field, ayah] = round_score(
                        (float(score) - mean) / deviation if deviation else 0.0
                    )
    return result


def load_index(path: Path) -> dict[str, Any]:
    index = json.loads(path.read_text(encoding="utf8"))
    if index.get("scope") != "all-fields" or index.get("schema_version") != 2:
        raise ValueError("Expected an all-fields v2 index")
    if tuple(field["name"] for field in index["fields"]) != FIELD_NAMES:
        raise ValueError("Unexpected semantic field order")
    if len(index["refs"]) != 6236 or len(set(index["refs"])) != 6236:
        raise ValueError("Expected 6,236 unique references")
    for field in index["fields"]:
        vector_path = path.parent / field["file"]
        if file_sha256(vector_path) != field["sha256"]:
            raise ValueError(f"{field['name']} vector hash mismatch")
        if vector_path.stat().st_size != field["bytes"]:
            raise ValueError(f"{field['name']} vector size mismatch")
    from ..build_meaning_index import validate_manifest
    from ..meaning_search import load_rows

    validate_manifest(index, load_rows(), path.parent)
    return index


def load_diagnostics(
    path: Path, fixture: Path, fixture_manifest: dict, index: dict, index_path: Path,
) -> dict:
    report = json.loads(path.read_text(encoding="utf8"))
    if report.get("scope") != "all-fields":
        raise ValueError("Diagnostics must use the all-fields worker scope")
    if report.get("fixture_sha256") != file_sha256(fixture):
        raise ValueError("Diagnostics fixture hash mismatch")
    if report.get("corpus") != index["corpus"]:
        raise ValueError("Diagnostics corpus hash mismatch")
    if report.get("asset_hashes", {}).get("index_sha256") != text_sha256(index_path):
        raise ValueError("Diagnostics index hash mismatch")
    # The frozen benchmark predates the move and the HF transport.
    historical_worker = "be14cb1eb60beefd0feaced476ca461ce7626f390cbe6dfdc2e995f6e55ebe86"
    if report.get("worker_sha256") not in (
        historical_worker, text_sha256(ASSET_ROOT / "js" / "meaning-worker.js"),
    ):
        raise ValueError("Diagnostics production worker hash mismatch")
    if report.get("worker_core_sha256") != text_sha256(ASSET_ROOT / "js" / "meaning-core.mjs"):
        raise ValueError("Diagnostics scoring-core hash mismatch")
    expected_ids = {case["id"] for case in read_jsonl(fixture)}
    if set(report["runs"]) != expected_ids:
        raise ValueError("Diagnostics ranking IDs do not match the fixture")
    for field in index["fields"]:
        if report["asset_hashes"]["vectors"].get(field["name"]) != field["sha256"]:
            raise ValueError(f"Diagnostics {field['name']} vector hash mismatch")
    for case_id, run in report["runs"].items():
        embedding = run.get("embedding")
        if not isinstance(embedding, list) or len(embedding) != index["dimensions"]:
            raise ValueError(f"{case_id}: expected an exact 384-dimensional query embedding")
        if any(not math.isfinite(value) for value in embedding):
            raise ValueError(f"{case_id}: non-finite query embedding")
        rankings = run.get("field_rankings") or []
        if tuple(row["field"] for row in rankings) != FIELD_NAMES:
            raise ValueError(f"{case_id}: incomplete per-field diagnostics")
        if any(len(row["rows"]) != 10 for row in rankings):
            raise ValueError(f"{case_id}: expected per-field top-ten rankings")
        fused_ranking = run.get("fused_ranking") or []
        if len(fused_ranking) != 10 or [row["ref"] for row in fused_ranking] != run["refs"]:
            raise ValueError(f"{case_id}: fused ranking diagnostics do not match the result")
    return report


def score_cache(
    diagnostics: dict,
    cases: list[dict],
    index: dict,
    index_path: Path,
    cache_path: Path,
    refresh: bool = False,
) -> dict[str, Any]:
    fingerprint = hashlib.sha256()
    fingerprint.update(text_sha256(index_path).encode())
    fingerprint.update(diagnostics["fixture_sha256"].encode())
    fingerprint.update(json.dumps(diagnostics["asset_hashes"], sort_keys=True).encode())
    for case in cases:
        run = diagnostics["runs"][case["id"]]
        fingerprint.update(np.asarray(run["embedding"], dtype="<f4").tobytes())
    fingerprint = fingerprint.hexdigest()
    if cache_path.is_file() and not refresh:
        cached = np.load(cache_path, allow_pickle=False)
        if str(cached["fingerprint"]) == fingerprint:
            return {
                "raw": cached["raw"], "ids": [str(value) for value in cached["ids"]],
                "fingerprint": fingerprint, "path": cache_path,
            }
    matrices = []
    for field in index["fields"]:
        vectors = np.fromfile(index_path.parent / field["file"], dtype=np.int8).reshape(
            -1, index["dimensions"]
        )
        if len(vectors) != len(field["passage_to_ayah"]):
            raise ValueError(f"{field['name']} vector/map length mismatch")
        norms = np.linalg.norm(vectors.astype(np.float64), axis=1)
        if np.any(norms == 0):
            raise ValueError(f"{field['name']} contains a zero vector")
        matrices.append((vectors, norms, np.asarray(field["passage_to_ayah"], dtype=np.int32)))
    raw = np.empty((len(cases), len(FIELD_NAMES), len(index["refs"])), dtype=np.float64)
    print(f"Reproducing browser scores for {len(cases)} queries", flush=True)
    for query_index, case in enumerate(cases):
        embedding = np.asarray(diagnostics["runs"][case["id"]]["embedding"], dtype=np.float64)
        for field_index, (vectors, norms, mapping) in enumerate(matrices):
            dots = np.einsum("ij,j->i", vectors, embedding, dtype=np.float64, optimize=False)
            passage_scores = round_scores(dots / norms)
            ayah_scores = np.full(len(index["refs"]), -np.inf, dtype=np.float64)
            np.maximum.at(ayah_scores, mapping, passage_scores)
            raw[query_index, field_index] = ayah_scores
        if (query_index + 1) % 25 == 0 or query_index + 1 == len(cases):
            print(f"  {query_index + 1}/{len(cases)}", flush=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        cache_path,
        raw=raw,
        ids=np.asarray([case["id"] for case in cases]),
        fingerprint=np.asarray(fingerprint),
    )
    return {"raw": raw, "ids": [case["id"] for case in cases], "fingerprint": fingerprint, "path": cache_path}


def top_indices(scores: np.ndarray) -> np.ndarray:
    return np.argsort(-scores, axis=1, kind="stable")[:, :10]


def rankings(indices: np.ndarray, refs: list[str], ids: list[str]) -> dict[str, list[str]]:
    return {
        case_id: [refs[int(index)] for index in row]
        for case_id, row in zip(ids, indices)
    }


def fuse_prepared(values: np.ndarray, weights: np.ndarray) -> np.ndarray:
    present = np.isfinite(values)
    numerator = np.zeros((values.shape[0], values.shape[2]), dtype=np.float64)
    denominator = np.zeros_like(numerator)
    for field, weight in enumerate(weights):
        numerator += weight * np.where(present[:, field], values[:, field], 0.0)
        denominator += weight * present[:, field]
    result = np.full_like(numerator, -np.inf)
    np.divide(numerator, denominator, out=result, where=denominator > 0)
    return round_scores(result)


def fuse(raw: np.ndarray, weights: np.ndarray, method: str) -> np.ndarray:
    if method not in ("weighted_raw", "weighted_z"):
        raise ValueError(f"Unknown fusion method: {method}")
    values = raw if method == "weighted_raw" else z_scores(raw)
    return fuse_prepared(values, weights)


def case_scores(cases: list[dict], ranked: dict[str, list[str]], score_group) -> dict[str, dict[str, float]]:
    return {case["id"]: score_group(ranked[case["id"]], case["qrels"]) for case in cases}


def macro(scores: dict[str, dict[str, float]]) -> dict[str, float]:
    return {metric: statistics.fmean(row[metric] for row in scores.values()) for metric in METRICS}


def metric_summary(cases: list[dict], scores: dict[str, dict[str, float]]) -> dict[str, Any]:
    selected = {case["id"]: scores[case["id"]] for case in cases}
    means = macro(selected)
    return {
        "queries": len(selected),
        "groups": len({case["group_id"] for case in cases}),
        "metrics": {metric: round(value, 6) for metric, value in means.items()},
    }


def useful_cases(cases: list[dict]) -> list[dict]:
    return [case for case in cases if any(grade >= 2 for grade in case["qrels"].values())]


def direct_cases(cases: list[dict]) -> list[dict]:
    return [case for case in cases if case["best_settled_label"] == "direct"]


def slice_summaries(cases: list[dict], scores: dict[str, dict[str, float]]) -> dict[str, Any]:
    slices = {
        "all_queries": cases,
        "useful_answerable": useful_cases(cases),
        "direct_answer_groups": direct_cases(cases),
    }
    return {
        label: metric_summary(selected, scores)
        for label, selected in slices.items() if selected
    }


def group_bootstrap_ci(
    cases: list[dict], scores: dict[str, dict[str, float]], samples: int, seed: int,
) -> dict[str, list[float]]:
    by_group: dict[str, list[dict[str, float]]] = defaultdict(list)
    for case in cases:
        by_group[case["group_id"]].append(scores[case["id"]])
    group_ids = sorted(by_group)
    totals = {
        group_id: {
            metric: sum(row[metric] for row in by_group[group_id]) for metric in METRICS
        }
        for group_id in group_ids
    }
    counts = {group_id: len(by_group[group_id]) for group_id in group_ids}
    if samples == 0:
        return {metric: None for metric in METRICS}
    rng = random.Random(seed)
    draws: dict[str, list[float]] = {metric: [] for metric in METRICS}
    for _ in range(samples):
        selected = rng.choices(group_ids, k=len(group_ids))
        count = sum(counts[group_id] for group_id in selected)
        for metric in METRICS:
            draws[metric].append(sum(totals[group_id][metric] for group_id in selected) / count)
    return {
        metric: [round(percentile(values, 0.025), 6), round(percentile(values, 0.975), 6)]
        for metric, values in draws.items()
    }


def paired_bootstrap(
    cases: list[dict],
    baseline: dict[str, dict[str, float]],
    candidate: dict[str, dict[str, float]],
    samples: int,
    seed: int,
) -> dict[str, Any]:
    by_group: dict[str, list[tuple[dict[str, float], dict[str, float]]]] = defaultdict(list)
    for case in cases:
        by_group[case["group_id"]].append((baseline[case["id"]], candidate[case["id"]]))
    group_ids = sorted(by_group)
    if samples == 0:
        return {
            metric: {
                "baseline_mean": round(statistics.fmean(baseline[case["id"]][metric] for case in cases), 6),
                "candidate_mean": round(statistics.fmean(candidate[case["id"]][metric] for case in cases), 6),
                "delta_mean": round(statistics.fmean(
                    candidate[case["id"]][metric] - baseline[case["id"]][metric] for case in cases
                ), 6),
                "delta_ci95": None,
                "wins": sum(candidate[case["id"]][metric] - baseline[case["id"]][metric] > 1e-12 for case in cases),
                "losses": sum(candidate[case["id"]][metric] - baseline[case["id"]][metric] < -1e-12 for case in cases),
                "ties": sum(abs(candidate[case["id"]][metric] - baseline[case["id"]][metric]) <= 1e-12 for case in cases),
            }
            for metric in METRICS
        } | {"bootstrap": {"samples": samples, "seed": seed, "method": "paired_question_group_resampling"}}
    rng = random.Random(seed)
    output = {}
    for metric in METRICS:
        deltas = [candidate[case["id"]][metric] - baseline[case["id"]][metric] for case in cases]
        group_deltas = {
            group_id: sum(right[metric] - left[metric] for left, right in by_group[group_id])
            for group_id in group_ids
        }
        group_counts = {group_id: len(by_group[group_id]) for group_id in group_ids}
        means = []
        for _ in range(samples):
            selected = rng.choices(group_ids, k=len(group_ids))
            means.append(sum(group_deltas[group_id] for group_id in selected) /
                         sum(group_counts[group_id] for group_id in selected))
        output[metric] = {
            "baseline_mean": round(statistics.fmean(baseline[case["id"]][metric] for case in cases), 6),
            "candidate_mean": round(statistics.fmean(candidate[case["id"]][metric] for case in cases), 6),
            "delta_mean": round(statistics.fmean(deltas), 6),
            "delta_ci95": [round(percentile(means, 0.025), 6), round(percentile(means, 0.975), 6)],
            "wins": sum(delta > 1e-12 for delta in deltas),
            "losses": sum(delta < -1e-12 for delta in deltas),
            "ties": sum(abs(delta) <= 1e-12 for delta in deltas),
        }
    output["bootstrap"] = {"samples": samples, "seed": seed, "method": "paired_question_group_resampling"}
    return output


def verify_browser_agreement(
    diagnostics: dict,
    cases: list[dict],
    raw: np.ndarray,
    refs: list[str],
    weights: np.ndarray,
    method: str,
) -> dict[str, Any]:
    per_field = top_indices(raw.reshape(-1, raw.shape[2])).reshape(raw.shape[0], len(FIELD_NAMES), 10)
    fused_scores = fuse(raw, weights, method)
    fused_indices = top_indices(fused_scores)
    expected_fusion = {
        "method": method,
        "weights": {name: float(weight) for name, weight in zip(FIELD_NAMES, weights)},
    }
    mismatches = []
    for query_index, case in enumerate(cases):
        run = diagnostics["runs"][case["id"]]
        if run.get("fusion") != expected_fusion:
            mismatches.append({"id": case["id"], "field": "fusion", "expected": expected_fusion, "actual": run.get("fusion")})
        for field_index, field in enumerate(FIELD_NAMES):
            indices = per_field[query_index, field_index]
            expected = [refs[int(index)] for index in indices]
            actual_rows = run["field_rankings"][field_index]["rows"]
            actual = [row["ref"] for row in actual_rows]
            expected_scores = [float(raw[query_index, field_index, int(index)]) for index in indices]
            actual_scores = [row["score"] for row in actual_rows]
            if expected != actual or expected_scores != actual_scores:
                mismatches.append({
                    "id": case["id"], "field": field, "expected": expected, "actual": actual,
                    "expected_scores": expected_scores, "actual_scores": actual_scores,
                })
        indices = fused_indices[query_index]
        expected = [refs[int(index)] for index in indices]
        expected_scores = [float(fused_scores[query_index, int(index)]) for index in indices]
        actual_scores = [row["score"] for row in run["fused_ranking"]]
        if expected != run["refs"] or expected_scores != actual_scores:
            mismatches.append({
                "id": case["id"], "field": "fused", "expected": expected, "actual": run["refs"],
                "expected_scores": expected_scores, "actual_scores": actual_scores,
            })
    if mismatches:
        raise ValueError(f"Offline/browser ranking mismatch: {json.dumps(mismatches[:3])}")
    return {"queries": len(cases), "per_field_rankings": len(cases) * len(FIELD_NAMES), "fused_rankings": len(cases), "exact": True}


def selection_key(cases: list[dict], scores: dict[str, dict[str, float]]) -> tuple[float, float, float]:
    means = macro(scores)
    answerable = macro({case["id"]: scores[case["id"]] for case in useful_cases(cases)})
    return answerable["useful_hit@5"], means["positive_hit@5"], means["ndcg@10"]


def tune_weights(
    raw: np.ndarray,
    cases: list[dict],
    refs: list[str],
    score_group,
    baseline_direct: float,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    starts = []
    for field in range(len(FIELD_NAMES)):
        weights = [0] * len(FIELD_NAMES)
        weights[field] = 10
        starts.append(tuple(weights))
    starts.append((2, 1, 1, 1, 2, 2, 1))
    evaluated: dict[tuple[str, tuple[int, ...]], dict[str, Any]] = {}
    selection_keys: dict[tuple[str, tuple[int, ...]], tuple[float, float, float]] = {}

    def evaluate(method: str, integer_weights: tuple[int, ...], prepared: np.ndarray) -> dict[str, Any]:
        key = (method, integer_weights)
        if key in evaluated:
            return evaluated[key]
        weights = np.asarray(integer_weights, dtype=np.float64) / 10
        ranked = rankings(top_indices(fuse_prepared(prepared, weights)), refs, [case["id"] for case in cases])
        scores = case_scores(cases, ranked, score_group)
        means = macro(scores)
        answerable = macro({case["id"]: scores[case["id"]] for case in useful_cases(cases)})
        direct = macro({case["id"]: scores[case["id"]] for case in direct_cases(cases)})
        guardrail = direct["direct_hit@5"] >= baseline_direct - 0.02 - 1e-12
        selection_keys[key] = selection_key(cases, scores)
        row = {
            "method": method,
            "weights": {name: int(value) / 10 for name, value in zip(FIELD_NAMES, integer_weights)},
            "metrics": {name: round(value, 6) for name, value in means.items()},
            "selection_metrics": {
                "useful_answerable_hit@5": round(answerable["useful_hit@5"], 6),
                "positive_hit@5": round(means["positive_hit@5"], 6),
                "ndcg@10": round(means["ndcg@10"], 6),
                "direct_answer_hit@5": round(direct["direct_hit@5"], 6),
            },
            "guardrail_pass": guardrail,
        }
        evaluated[key] = row
        return row

    candidates = []
    for method in ("weighted_raw", "weighted_z"):
        prepared = raw if method == "weighted_raw" else z_scores(raw)
        for start in starts:
            current = start
            current_row = evaluate(method, current, prepared)
            while True:
                best = None
                best_key = selection_keys[(method, current)] if current_row["guardrail_pass"] else (-1, -1, -1)
                for source in range(len(FIELD_NAMES)):
                    if current[source] == 0:
                        continue
                    for destination in range(len(FIELD_NAMES)):
                        if source == destination:
                            continue
                        neighbor = list(current)
                        neighbor[source] -= 1
                        neighbor[destination] += 1
                        neighbor = tuple(neighbor)
                        row = evaluate(method, neighbor, prepared)
                        if not row["guardrail_pass"]:
                            continue
                        key = selection_keys[(method, neighbor)]
                        if key > best_key:
                            best_key = key
                            best = neighbor
                if best is None:
                    break
                current = best
                current_row = evaluate(method, current, prepared)
            candidates.append(current_row)
        print(f"Tuned {method}: {len(evaluated)} unique configurations", flush=True)
    valid = [row for row in evaluated.values() if row["guardrail_pass"]]
    valid.sort(key=lambda row: (
        row["selection_metrics"]["useful_answerable_hit@5"],
        row["selection_metrics"]["positive_hit@5"],
        row["selection_metrics"]["ndcg@10"],
        row["method"], tuple(row["weights"][name] for name in FIELD_NAMES),
    ), reverse=True)
    if not valid:
        raise ValueError("No fusion configuration satisfied the direct-answer guardrail")
    best = valid[0]
    return best, sorted(evaluated.values(), key=lambda row: (
        row["method"], tuple(row["weights"][name] for name in FIELD_NAMES),
    ))


def freeze_manifest(index_path: Path, best: dict, validation: dict) -> None:
    index = json.loads(index_path.read_text(encoding="utf8"))
    fusion = dict(index["fusion"])
    fusion.update({
        "status": "frozen",
        "method": best["method"],
        "weights": best["weights"],
        "validation": validation,
    })
    index["fusion"] = fusion
    payload = (json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf8")
    temporary = index_path.with_name(index_path.name + ".tmp")
    temporary.write_bytes(payload)
    temporary.replace(index_path)
    from ..build_meaning_index import validate_assets
    from ..meaning_search import load_rows

    validate_assets(index_path, load_rows())


def verify_frozen_validation(index: dict, index_path: Path, report_path: Path) -> dict[str, Any]:
    report = json.loads(report_path.read_text(encoding="utf8"))
    validation = index["fusion"].get("validation", {})
    selected = report.get("selected", {})
    if (
        report.get("purpose") != "validation_model_selection_only"
        or report.get("split") != "validation"
        or report.get("fixture_manifest", {}).get("split") != "validation"
        or report.get("duplicate_validation_runs_identical") is not True
        or report.get("browser_offline_agreement", {}).get("exact") is not True
        or report.get("index_sha256_after_freeze") != text_sha256(index_path)
        or selected.get("method") != index["fusion"].get("method")
        or selected.get("weights") != index["fusion"].get("weights")
        or report.get("fixture_sha256") != validation.get("fixture_sha256")
        or report.get("diagnostics_sha256") != validation.get("diagnostics_sha256")
        or report.get("duplicate_diagnostics") != validation.get("duplicate_diagnostics")
        or report.get("score_cache", {}).get("fingerprint") != validation.get("score_cache_fingerprint")
        or report.get("selection", {}).get("guardrail", {}).get("pass") is not True
        or validation.get("guardrail", {}).get("pass") is not True
    ):
        raise ValueError("Frozen fusion does not match its validation report")
    return {
        "file": report_path.name,
        "sha256": file_sha256(report_path),
        "fixture_sha256": report["fixture_sha256"],
        "diagnostics_sha256": report["diagnostics_sha256"],
        "selected": selected,
        "verified": True,
    }


def fixture_args(parser: argparse.ArgumentParser, split: str) -> None:
    parser.set_defaults(expected_split=split)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument("--fixture", type=Path, default=HERE / (
        "validation" if split == "validation" else ""
    ) / f"islamqa_pr2_{split}_queries.jsonl")
    parser.add_argument(
        "--fixture-manifest",
        type=Path,
        default=(
            HERE / "validation" / "islamqa_pr2_validation_fixture_manifest.json"
            if split == "validation"
            else HERE / MANIFEST_NAME
        ),
    )
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)


def load_context(args: argparse.Namespace):
    cases, fixture_manifest = load_fixture(args.fixture, args.fixture_manifest)
    if fixture_manifest["split"] != args.expected_split:
        raise ValueError(f"This command requires the {args.expected_split} split")
    verify_package_files(args.package, fixture_manifest)
    _, _, score_group = package_modules(args.package)
    index = load_index(args.index)
    diagnostics = load_diagnostics(args.diagnostics, args.fixture, fixture_manifest, index, args.index)
    return cases, fixture_manifest, score_group, index, diagnostics


def tune(args: argparse.Namespace) -> None:
    cases, fixture_manifest, score_group, index, diagnostics = load_context(args)
    cache = score_cache(
        diagnostics, cases, index, args.index,
        args.cache or HERE / ".cache" / f"{fixture_manifest['split']}_scores.npz",
        refresh=args.refresh_cache,
    )
    raw = cache["raw"]
    configured = index["fusion"]
    weights = np.asarray([configured["weights"][name] for name in FIELD_NAMES], dtype=np.float64)
    agreement = verify_browser_agreement(
        diagnostics, cases, raw, index["refs"], weights, configured["method"]
    )
    baseline_ranked = rankings(top_indices(raw[:, FIELD_NAMES.index("en")]), index["refs"], cache["ids"])
    baseline_scores = case_scores(cases, baseline_ranked, score_group)
    baseline_direct = macro({
        case["id"]: baseline_scores[case["id"]] for case in direct_cases(cases)
    })["direct_hit@5"]
    duplicate_identical = False
    if args.diagnostics_b:
        second = load_diagnostics(args.diagnostics_b, args.fixture, fixture_manifest, index, args.index)
        second_cache = score_cache(
            second, cases, index, args.index,
            args.cache_b or HERE / ".cache" / f"{fixture_manifest['split']}_scores_b.npz",
            refresh=args.refresh_cache,
        )
        verify_browser_agreement(second, cases, second_cache["raw"], index["refs"], weights, configured["method"])
        duplicate_identical = (
            np.array_equal(raw, second_cache["raw"]) and
            all(diagnostics["runs"][case["id"]]["embedding"] == second["runs"][case["id"]]["embedding"] for case in cases) and
            all(diagnostics["runs"][case["id"]]["refs"] == second["runs"][case["id"]]["refs"] for case in cases) and
            all(diagnostics["runs"][case["id"]]["field_rankings"] == second["runs"][case["id"]]["field_rankings"] for case in cases) and
            all(diagnostics["runs"][case["id"]]["fused_ranking"] == second["runs"][case["id"]]["fused_ranking"] for case in cases)
        )
        if not duplicate_identical:
            raise ValueError("Duplicate validation browser runs produced different embeddings or rankings")
    if args.freeze and not duplicate_identical:
        raise ValueError("Freezing requires two identical validation browser runs")
    best, evaluated = tune_weights(raw, cases, index["refs"], score_group, baseline_direct)
    selected_weights = np.asarray([best["weights"][name] for name in FIELD_NAMES], dtype=np.float64)
    selected_ranked = rankings(top_indices(fuse(raw, selected_weights, best["method"])), index["refs"], cache["ids"])
    selected_scores = case_scores(cases, selected_ranked, score_group)
    field_rows = {}
    for field_index, field in enumerate(FIELD_NAMES):
        ranked = rankings(top_indices(raw[:, field_index]), index["refs"], cache["ids"])
        scores = case_scores(cases, ranked, score_group)
        field_rows[field] = {
            **metric_summary(cases, scores),
            "slices": slice_summaries(cases, scores),
            "ci95": group_bootstrap_ci(cases, scores, args.bootstrap, args.seed),
            "coverage": coverage(cases, ranked),
        }
    report = {
        "purpose": "validation_model_selection_only",
        "split": fixture_manifest["split"],
        "fixture": args.fixture.name,
        "fixture_sha256": file_sha256(args.fixture),
        "fixture_manifest": fixture_manifest,
        "diagnostics": args.diagnostics.name,
        "diagnostics_sha256": file_sha256(args.diagnostics),
        "duplicate_diagnostics": {
            "file": args.diagnostics_b.name if args.diagnostics_b else None,
            "sha256": file_sha256(args.diagnostics_b) if args.diagnostics_b else None,
            "score_cache_fingerprint": second_cache["fingerprint"] if args.diagnostics_b else None,
        },
        "index_sha256_before_freeze": text_sha256(args.index),
        "score_cache": {"fingerprint": cache["fingerprint"], "file": str(cache["path"])},
        "browser_offline_agreement": agreement,
        "duplicate_validation_runs_identical": duplicate_identical,
        "selection": {
            "metric_order": ["useful_answerable_hit@5", "positive_hit@5", "ndcg@10"],
            "slices": {
                "useful_answerable_hit@5": "cases with at least one settled grade-2 or grade-3 ayah",
                "positive_hit@5": "all validation queries",
                "ndcg@10": "all validation queries",
                "direct_answer_hit@5": "groups whose best settled label is direct",
            },
            "weight_step": 0.1,
            "search": "greedy pairwise coordinate transfers from each single field and a balanced start",
            "guardrail": {
                "metric": "direct_hit@5", "maximum_drop_percentage_points": 2.0,
                "translation_only": round(baseline_direct, 6),
                "selected": best["selection_metrics"]["direct_answer_hit@5"],
                "pass": best["guardrail_pass"],
            },
        },
        "selected": best,
        "selected_summary": {
            **metric_summary(cases, selected_scores),
            "slices": slice_summaries(cases, selected_scores),
            "ci95": group_bootstrap_ci(cases, selected_scores, args.bootstrap, args.seed),
        },
        "translation_only_summary": {
            **metric_summary(cases, baseline_scores),
            "slices": slice_summaries(cases, baseline_scores),
        },
        "fields": field_rows,
        "evaluated_configurations": evaluated,
        "limitations": [
            "Validation labels are provisional and model-assisted; this is not a blind benchmark.",
            "Only English query wordings are available.",
            "The test split was not loaded or scored by this tuning command.",
        ],
    }
    if args.freeze:
        freeze_manifest(args.index, best, {
            "fixture_sha256": report["fixture_sha256"],
            "diagnostics_sha256": report["diagnostics_sha256"],
            "duplicate_diagnostics": report["duplicate_diagnostics"],
            "score_cache_fingerprint": cache["fingerprint"],
            "selected": best,
            "guardrail": report["selection"]["guardrail"],
        })
        report["index_sha256_after_freeze"] = text_sha256(args.index)
    write_json(args.output, report)
    args.output.with_suffix(".md").write_text(validation_markdown(report), encoding="utf8")
    print(json.dumps({"selected": best, "output": str(args.output)}, indent=2))


def baseline_report(
    path: Path, fixture_hash: str, expected_corpus: str, refs: set[str], cases: list[dict], kind: str,
) -> dict:
    report = json.loads(path.read_text(encoding="utf8"))
    if report["fixture_sha256"] != fixture_hash:
        raise ValueError(f"{path.name}: fixture hash mismatch")
    report_corpus = report["corpus"] if kind == "pr2_translation" else report["corpus"]["sha256"]
    if report_corpus != expected_corpus:
        raise ValueError(f"{path.name}: corpus hash mismatch")
    validate_rankings(cases, report, refs)
    if kind == "deploy":
        if report["revision"] != DEPLOY_REVISION:
            raise ValueError("Deploy revision mismatch")
        expected_blobs = LEXICAL_BLOBS["deploy"]
    elif kind in ("pr1_translation", "pr1_all"):
        expected_field = "translation" if kind == "pr1_translation" else "all"
        if report["revision"] != BASELINE_REVISION or report["field"] != expected_field:
            raise ValueError(f"{kind} revision/field mismatch")
        expected_blobs = LEXICAL_BLOBS["fcs"]
    elif kind == "pr2_translation":
        if report["product_commit"] != PR_REVISION:
            raise ValueError("PR #2 translation revision mismatch")
        for key, expected in MEANING_ASSET_SHA256.items():
            if report.get(key) != expected:
                raise ValueError(f"PR #2 translation {key} mismatch")
        return report
    else:
        raise ValueError(f"Unknown baseline kind: {kind}")
    for key, expected in expected_blobs.items():
        if report.get(key) != expected:
            raise ValueError(f"{kind} {key} mismatch")
    return report


def percentile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("Cannot calculate a percentile of an empty sample")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def latency(values: Iterable[float]) -> dict[str, float | None]:
    ordered = sorted(values)
    if not ordered:
        return {"p50": None, "p95": None}
    return {"p50": ordered[math.ceil(0.50 * len(ordered)) - 1], "p95": ordered[math.ceil(0.95 * len(ordered)) - 1]}


def validation_markdown(report: dict) -> str:
    selected = report["selected"]
    guardrail = report["selection"]["guardrail"]
    lines = [
        "# All-fields semantic search: validation tuning report",
        "",
        "This report is for model selection only. It contains no held-out test scores.",
        "",
        f"- Fixture: `{report['fixture']}` ({report['selected_summary']['queries']} queries, "
        f"{report['selected_summary']['groups']} question groups)",
        f"- Duplicate validation runs identical: {report['duplicate_validation_runs_identical']}",
        f"- Browser/offline exact agreement: {report['browser_offline_agreement']['exact']}",
        f"- Evaluated configurations: {len(report['evaluated_configurations'])}",
        "",
        "## Selected fusion",
        "",
        f"- Method: `{selected['method']}`",
        f"- Useful-answerable Hit@5: {selected['selection_metrics']['useful_answerable_hit@5']:.1%}",
        f"- All-query relevant Hit@5: {selected['selection_metrics']['positive_hit@5']:.1%}",
        f"- All-query NDCG@10: {selected['selection_metrics']['ndcg@10']:.4f}",
        f"- Direct-answer Hit@5: {selected['selection_metrics']['direct_answer_hit@5']:.1%} "
        f"(translation-only {guardrail['translation_only']:.1%}; guardrail passed: {guardrail['pass']})",
        "",
        "| Field | Weight |",
        "| --- | ---: |",
    ]
    lines.extend(f"| {name} | {weight:.1f} |" for name, weight in selected["weights"].items())
    lines.extend([
        "",
        "## Standalone semantic fields",
        "",
        "| Field | Relevant Hit@5 (all) | Useful Hit@5 (useful-answerable) | "
        "Direct Hit@5 (direct groups) | MRR@10 (all) | NDCG@10 (all) |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ])
    for name, row in report["fields"].items():
        metrics = row["metrics"]
        useful = row["slices"]["useful_answerable"]["metrics"]["useful_hit@5"]
        direct = row["slices"]["direct_answer_groups"]["metrics"]["direct_hit@5"]
        lines.append(
            f"| {name} | {metrics['positive_hit@5']:.1%} | {useful:.1%} | {direct:.1%} | "
            f"{metrics['mrr@10']:.4f} | {metrics['ndcg@10']:.4f} |"
        )
    lines.extend([
        "",
        "Weights use 0.1 steps and greedy pairwise coordinate transfers. Selection order is "
        "useful-answerable Hit@5, all-query relevant Hit@5, then all-query NDCG@10. "
        "The direct-answer guardrail may not drop more than two percentage points below translation-only meaning search.",
        "",
        "Validation labels are provisional, model-assisted, non-blind, and English-only.",
        "",
    ])
    return "\n".join(lines)


def markdown_report(result: dict) -> str:
    lines = [
        "# All-fields semantic search: held-out test report",
        "",
        "The fusion configuration was selected on validation only. The test fixture was not used for tuning.",
        "",
        "| Run | Relevant Hit@5 (all) | Useful Hit@5 (useful-answerable) | "
        "Direct Hit@5 (direct groups) | MRR@10 (all) | NDCG@10 (all) | Recall@5 (all) | Recall@10 (all) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name, row in result["runs"].items():
        metrics = row["metrics"]
        useful = row["slices"]["useful_answerable"]["metrics"]["useful_hit@5"]
        direct = row["slices"]["direct_answer_groups"]["metrics"]["direct_hit@5"]
        lines.append(
            f"| {name} | {metrics['positive_hit@5']:.1%} | {useful:.1%} | {direct:.1%} | "
            f"{metrics['mrr@10']:.4f} | {metrics['ndcg@10']:.4f} | "
            f"{metrics['recall@5']:.1%} | {metrics['recall@10']:.1%} |"
        )
    comparison = result["comparisons"]["pr2_meaning_all_fields_vs_pr1_keyword_all_fields"]
    lines.extend([
        "",
        "## Fused meaning versus PR #1 all-fields keyword",
        "",
        "| Metric | Delta | Paired group-bootstrap 95% CI | Wins | Losses | Ties |",
        "| --- | ---: | --- | ---: | ---: | ---: |",
    ])
    for metric in ("positive_hit@5", "useful_hit@5", "direct_hit@5", "mrr@10", "ndcg@10"):
        row = comparison[metric]
        interval = row["delta_ci95"]
        ci = f"[{interval[0]:+.4f}, {interval[1]:+.4f}]" if interval else "not requested"
        lines.append(
            f"| {metric} | {row['delta_mean']:+.4f} | {ci} | {row['wins']} | {row['losses']} | {row['ties']} |"
        )
    lines.extend([
        "",
        "Relevant Hit@5, MRR, NDCG, and recall use all test queries. Useful Hit@5 uses only "
        "cases with a settled useful answer; direct Hit@5 uses only direct-answer question groups.",
        "",
        "## Verification and cost",
        "",
        f"- Validation provenance verified: {result['validation_provenance']['verified']}",
        f"- Browser/offline exact agreement: {result['verification']['browser_offline_exact']}",
        f"- Duplicate browser runs identical: {result['verification']['duplicate_runs_identical']}",
        f"- Translation baseline reproduced exactly for {result['verification']['translation_baseline_queries']} queries: "
        f"{result['verification']['translation_baseline_exact']}",
        f"- Vector assets: {result['assets']['vector_bytes'] / 1e6:.2f} MB in "
        f"{result['assets']['vector_files']} unique files",
        f"- Cold loopback transfer (model plus semantic assets): "
        f"{result['cold_asset_transfer']['bytes'] / 1e6:.2f} MB in "
        f"{result['cold_asset_transfer']['requests']} requests",
        f"- Warmed browser p50/p95: {result['latency_ms']['all_fields']['p50']}/"
        f"{result['latency_ms']['all_fields']['p95']} ms",
        "",
        "The JSON report contains every standalone field, paired comparison, confidence interval, "
        "win/loss count, judgment-coverage count, asset hash, and per-query timing.",
        "",
        "The dataset remains provisional, non-blind, model-assisted, and English-only. "
        "Cold transfer uses loopback; warmed timings are not production latency.",
        "",
    ])
    return "\n".join(lines)


def report(args: argparse.Namespace) -> None:
    cases, fixture_manifest, score_group, index, diagnostics = load_context(args)
    cache = score_cache(
        diagnostics, cases, index, args.index,
        args.cache or HERE / ".cache" / f"{fixture_manifest['split']}_scores.npz",
        refresh=args.refresh_cache,
    )
    raw = cache["raw"]
    configured = index["fusion"]
    if configured.get("status") != "frozen":
        raise ValueError("The test report requires a validation-frozen fusion configuration")
    validation_provenance = verify_frozen_validation(index, args.index, args.validation_report)
    weights = np.asarray([configured["weights"][name] for name in FIELD_NAMES], dtype=np.float64)
    agreement = verify_browser_agreement(diagnostics, cases, raw, index["refs"], weights, configured["method"])
    if not args.diagnostics_b:
        raise ValueError("The final report requires a second browser diagnostics run")
    second = load_diagnostics(args.diagnostics_b, args.fixture, fixture_manifest, index, args.index)
    second_cache = score_cache(
        second, cases, index, args.index,
        args.cache_b or HERE / ".cache" / f"{fixture_manifest['split']}_scores_b.npz",
        refresh=args.refresh_cache,
    )
    duplicate_agreement = verify_browser_agreement(second, cases, second_cache["raw"], index["refs"], weights, configured["method"])
    duplicate_identical = (
        np.array_equal(raw, second_cache["raw"]) and
        all(diagnostics["runs"][case["id"]]["embedding"] == second["runs"][case["id"]]["embedding"] for case in cases) and
        all(diagnostics["runs"][case["id"]]["refs"] == second["runs"][case["id"]]["refs"] for case in cases) and
        all(diagnostics["runs"][case["id"]]["field_rankings"] == second["runs"][case["id"]]["field_rankings"] for case in cases) and
        all(diagnostics["runs"][case["id"]]["fused_ranking"] == second["runs"][case["id"]]["fused_ranking"] for case in cases)
    )
    if not duplicate_identical:
        raise ValueError("Duplicate browser runs produced different embeddings or rankings")
    fixture_hash = file_sha256(args.fixture)
    refs = set(index["refs"])
    baseline_paths = {
        "deploy_keyword_translation": (args.deploy, "deploy"),
        "pr1_keyword_translation": (args.fcs, "pr1_translation"),
        "pr1_keyword_all_fields": (args.fcs_all, "pr1_all"),
        "pr2_meaning_translation": (args.meaning, "pr2_translation"),
    }
    ranked_runs = {}
    source_reports = {}
    baseline_documents = {}
    for name, (path, kind) in baseline_paths.items():
        baseline = baseline_report(
            path, fixture_hash, fixture_manifest["corpus"]["sha256"], refs, cases, kind
        )
        source_reports[name] = {"file": path.name, "sha256": file_sha256(path)}
        baseline_documents[name] = baseline
        ranked_runs[name] = {case["id"]: baseline["runs"][case["id"]]["refs"] for case in cases}
    for field_index, field in enumerate(FIELD_NAMES):
        ranked_runs[f"semantic_{field}"] = rankings(top_indices(raw[:, field_index]), index["refs"], cache["ids"])
    ranked_runs["pr2_meaning_all_fields"] = rankings(top_indices(fuse(raw, weights, configured["method"])), index["refs"], cache["ids"])
    scores = {name: case_scores(cases, ranked, score_group) for name, ranked in ranked_runs.items()}
    translation_exact = all(
        ranked_runs["semantic_en"][case["id"]] == ranked_runs["pr2_meaning_translation"][case["id"]]
        for case in cases
    )
    if not translation_exact:
        raise ValueError("The all-fields translation index did not reproduce the PR #2 baseline")
    runs = {}
    for name, values in scores.items():
        runs[name] = {
            **metric_summary(cases, values),
            "slices": slice_summaries(cases, values),
            "ci95": group_bootstrap_ci(cases, values, args.bootstrap, args.seed),
            "coverage": coverage(cases, ranked_runs[name]),
            "source": source_reports.get(name, "offline scoring of saved browser query embeddings"),
        }
    def compare(baseline_name: str, candidate_name: str) -> dict[str, Any]:
        all_metrics = paired_bootstrap(
            cases, scores[baseline_name], scores[candidate_name], args.bootstrap, args.seed
        )
        useful_metrics = paired_bootstrap(
            useful_cases(cases), scores[baseline_name], scores[candidate_name],
            args.bootstrap, args.seed,
        )
        direct_metrics = paired_bootstrap(
            direct_cases(cases), scores[baseline_name], scores[candidate_name],
            args.bootstrap, args.seed,
        )
        return {
            metric: (
                useful_metrics[metric] if metric == "useful_hit@5" else
                direct_metrics[metric] if metric == "direct_hit@5" else
                all_metrics[metric]
            )
            for metric in METRICS
        }

    comparisons = {}
    for candidate in ranked_runs:
        if candidate == "pr1_keyword_all_fields":
            continue
        comparisons[f"{candidate}_vs_pr1_keyword_all_fields"] = compare(
            "pr1_keyword_all_fields", candidate
        )
    comparisons["pr2_meaning_all_fields_vs_pr2_meaning_translation"] = compare(
        "pr2_meaning_translation", "pr2_meaning_all_fields"
    )
    lexical_timings = {
        name: latency(baseline_documents[name]["runs"][case["id"]]["ms"] for case in cases)
        for name in ("deploy_keyword_translation", "pr1_keyword_translation", "pr1_keyword_all_fields")
    }
    result = {
        "purpose": "held_out_test_no_tuning",
        "split": fixture_manifest["split"],
        "fixture": args.fixture.name,
        "fixture_sha256": fixture_hash,
        "fixture_manifest": fixture_manifest,
        "fusion": configured,
        "index_sha256": text_sha256(args.index),
        "diagnostics": [args.diagnostics.name] + ([args.diagnostics_b.name] if args.diagnostics_b else []),
        "diagnostics_sha256": [file_sha256(args.diagnostics)] + ([file_sha256(args.diagnostics_b)] if args.diagnostics_b else []),
        "score_cache_fingerprints": [cache["fingerprint"]] + ([second_cache["fingerprint"]] if args.diagnostics_b else []),
        "validation_provenance": validation_provenance,
        "verification": {
            "browser_offline_exact": agreement["exact"],
            "duplicate_runs_identical": duplicate_identical,
            "duplicate_browser_offline_exact": duplicate_agreement["exact"] if duplicate_agreement else None,
            "translation_baseline_exact": translation_exact,
            "translation_baseline_queries": len(cases),
        },
        "runs": runs,
        "comparisons": comparisons,
        "assets": {
            "vector_bytes": index["assets"]["vector_bytes"],
            "vector_files": index["assets"]["unique_vector_files"],
            "field_passages": {field["name"]: field["passages"] for field in index["fields"]},
            "translation_baseline_bytes": (ASSET_ROOT / "verses-d1c40be0bef5-e5-v1.bin").stat().st_size,
            "index_sha256": text_sha256(args.index),
            "vector_sha256": diagnostics["asset_hashes"]["vectors"],
        },
        "latency_ms": {
            "all_fields": latency(diagnostics["runs"][case["id"]]["ms"] for case in cases[1:]),
            "all_fields_worker": {
                stage: latency(
                    diagnostics["runs"][case["id"]]["worker_timings"][stage] for case in cases[1:]
                )
                for stage in ("load_ms", "embedding_ms", "scoring_ms")
            },
            "pr2_meaning_translation": {
                "p50": baseline_documents["pr2_meaning_translation"]["warm_p50_ms"],
                "p95": baseline_documents["pr2_meaning_translation"]["warm_p95_ms"],
            },
            **lexical_timings,
        },
        "cold_asset_transfer": diagnostics["cold_asset_transfer"],
        "limitations": [
            "The IslamQA package is provisional and not benchmark-grade.",
            "Test questions were visible during model-assisted review; the split is not blind.",
            "Labels and citation corrections lack independent scholarly review.",
            "Pooled judgments are incomplete; unjudged results earn no gain.",
            "The evaluation is English-only and does not establish Arabic or Bengali query quality.",
            "Cold transfer uses a fresh browser and loopback server; warmed timings are not production latency.",
        ],
    }
    write_json(args.output, result)
    args.output.with_suffix(".md").write_text(markdown_report(result), encoding="utf8")
    write_jsonl(args.rankings_output, (
        {"run": name, "id": case["id"], "group_id": case["group_id"], "ranking": ranked_runs[name][case["id"]]}
        for name in ranked_runs for case in cases
    ))
    print(markdown_report(result))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    tune_parser = subparsers.add_parser("tune", help="Tune and optionally freeze on validation only")
    fixture_args(tune_parser, "validation")
    tune_parser.add_argument("--diagnostics", type=Path, default=HERE / "validation" / "islamqa_pr2_all_fields_browser.json")
    tune_parser.add_argument("--diagnostics-b", type=Path, default=HERE / "validation" / "islamqa_pr2_all_fields_browser_b.json")
    tune_parser.add_argument("--cache", type=Path)
    tune_parser.add_argument("--cache-b", type=Path)
    tune_parser.add_argument("--refresh-cache", action="store_true")
    tune_parser.add_argument("--freeze", action="store_true")
    tune_parser.add_argument("--output", type=Path, default=HERE / "validation" / "islamqa_pr2_all_fields_validation_report.json")
    tune_parser.add_argument("--bootstrap", type=int, default=2000)
    tune_parser.add_argument("--seed", type=int, default=4213)
    tune_parser.set_defaults(func=tune)

    report_parser = subparsers.add_parser("report", help="Score the held-out split with a frozen configuration")
    fixture_args(report_parser, "test")
    report_parser.add_argument("--diagnostics", type=Path, default=HERE / "islamqa_pr2_all_fields_browser_a.json")
    report_parser.add_argument("--diagnostics-b", type=Path, default=HERE / "islamqa_pr2_all_fields_browser_b.json")
    report_parser.add_argument("--cache", type=Path)
    report_parser.add_argument("--cache-b", type=Path)
    report_parser.add_argument("--refresh-cache", action="store_true")
    report_parser.add_argument("--deploy", type=Path, default=HERE / DEPLOY_NAME)
    report_parser.add_argument("--fcs", type=Path, default=HERE / FCS_NAME)
    report_parser.add_argument("--fcs-all", type=Path, default=HERE / "islamqa_pr2_fcs_all_fields_rankings.json")
    report_parser.add_argument("--meaning", type=Path, default=HERE / MEANING_NAME)
    report_parser.add_argument("--validation-report", type=Path, default=HERE / "validation" / "islamqa_pr2_all_fields_validation_report.json")
    report_parser.add_argument("--output", type=Path, default=HERE / "islamqa_pr2_all_fields_test_report.json")
    report_parser.add_argument("--rankings-output", type=Path, default=HERE / "islamqa_pr2_all_fields_test_rankings.jsonl")
    report_parser.add_argument("--bootstrap", type=int, default=2000)
    report_parser.add_argument("--seed", type=int, default=4213)
    report_parser.set_defaults(func=report)
    args = parser.parse_args()
    if args.bootstrap < 0:
        parser.error("--bootstrap must be non-negative")
    args.func(args)


if __name__ == "__main__":
    main()
