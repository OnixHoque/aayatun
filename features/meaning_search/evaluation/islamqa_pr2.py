"""Prepare, run, and score the IslamQA test split against Aayatun PR #2."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import io
import json
import math
from pathlib import Path
import random
import re
import sqlite3
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
import types
from typing import Any, Callable, Iterable


HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[3]
DEFAULT_PACKAGE = (
    WORKSPACE / "Daleel" / "daleel-islamqa-review" / "datasets"
    / "sanitized_islamqa" / "split_package"
)
DEFAULT_REPO = WORKSPACE / "aayatun-research"
DEPLOY_REVISION = "d9cff5d3f21dc11423465893fb1839dd6c9251c0"
BASELINE_REVISION = "54990b849f176d722fb087372c8875cb2d7c6e14"
PR_REVISION = "357a367ef4631cb771cdd9e3a34116280c7dd2d8"
LEXICAL_BLOBS = {
    "deploy": {
        "searchnorm_blob": "b106e0ff964e4fb5bdf5ed6f3a3543e8df472df2",
        "searchtool_blob": "a7973e5d3c34300f0876fe0be3658bc163c8b1cc",
        "build_search_blob": "e497f9bba5c93b9ff83c7192388ce9d781f94f93",
        "en_quran_blob": "bea5fd6cac389dc3258183e6261cd08f4e8758e9",
        "synonyms_blob": "9d7495d29bc71561d521b5c3cec94b1fde4f4b60",
    },
    "fcs": {
        "searchnorm_blob": "b106e0ff964e4fb5bdf5ed6f3a3543e8df472df2",
        "searchtool_blob": "5fe6e25542514e16e77a2abab411bfe4aec82fb1",
        "build_search_blob": "1a5fb561aad9ea0d7481d3191a4b22b7cf9205fd",
        "en_quran_blob": "bea5fd6cac389dc3258183e6261cd08f4e8758e9",
        "synonyms_blob": "9d7495d29bc71561d521b5c3cec94b1fde4f4b60",
    },
}
MEANING_MODEL_FILES = {
    "Xenova/multilingual-e5-small/config.json": "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    "Xenova/multilingual-e5-small/tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    "Xenova/multilingual-e5-small/tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    "Xenova/multilingual-e5-small/onnx/model_int8.onnx": "4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c",
}
MEANING_ASSET_SHA256 = {
    "worker_sha256": "445fb57fb91ee6b1ef8fea11d618a88eaa6d9ad6b944ed930f09dec0ece4171a",
    "index_sha256": "495726e9d693af8c3a21f587a6ca6139d7b78476586b7ece3d9f954240f89a21",
    "vectors_sha256": "0cad61636eb49d656fb65e705da4b84f2038c2a771a10bc6bf3d57e16fc071e5",
    "model_config_sha256": MEANING_MODEL_FILES[
        "Xenova/multilingual-e5-small/config.json"
    ],
    "model_tokenizer_sha256": MEANING_MODEL_FILES[
        "Xenova/multilingual-e5-small/tokenizer.json"
    ],
    "model_tokenizer_config_sha256": MEANING_MODEL_FILES[
        "Xenova/multilingual-e5-small/tokenizer_config.json"
    ],
    "model_weights_sha256": MEANING_MODEL_FILES[
        "Xenova/multilingual-e5-small/onnx/model_int8.onnx"
    ],
}
FIXTURE_NAME = "islamqa_pr2_test_queries.jsonl"
MANIFEST_NAME = "islamqa_pr2_fixture_manifest.json"
DEPLOY_NAME = "islamqa_pr2_deploy_rankings.json"
FCS_NAME = "islamqa_pr2_fcs_rankings.json"
MEANING_NAME = "islamqa_pr2_meaning_rankings.json"
RESULTS_NAME = "islamqa_pr2_results.json"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
        for row in rows
    )
    path.write_bytes(payload.encode("utf8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    path.write_bytes(payload.encode("utf8"))


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_sha256(path: Path) -> str:
    normalized = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(normalized).hexdigest()


def corpus_hash(corpus: dict[str, str]) -> str:
    return hashlib.sha256(
        json.dumps(corpus, sort_keys=True).encode("utf8")
    ).hexdigest()


def load_dataset_corpus(path: Path) -> dict[str, str]:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as db:
        rows = db.execute(
            "SELECT sura, ayah, text FROM verses ORDER BY sura, ayah"
        ).fetchall()
    corpus = {f"{surah}:{ayah}": text for surah, ayah, text in rows}
    if len(corpus) != len(rows):
        raise ValueError("Dataset corpus contains duplicate ayah references")
    return corpus


def load_search_corpus(path: Path) -> dict[str, str]:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as db:
        rows = db.execute(
            "SELECT surah, verse, en FROM docs ORDER BY surah, verse"
        ).fetchall()
    corpus = {f"{surah}:{verse}": text for surah, verse, text in rows}
    if len(corpus) != len(rows):
        raise ValueError("Search corpus contains duplicate ayah references")
    return corpus


def package_modules(package: Path):
    package = package.resolve()
    if str(package) not in sys.path:
        sys.path.insert(0, str(package))
    from evaluate_search import METRICS, score_group
    from load_dataset import Dataset

    return Dataset, METRICS, score_group


def resolve_revision(repo: Path, revision: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", revision],
        text=True,
    ).strip()


def git_blob(repo: Path, revision: str, path: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", f"{revision}:{path}"],
        text=True,
    ).strip()


def prepare(args: argparse.Namespace) -> None:
    Dataset, _, _ = package_modules(args.package)
    dataset = Dataset.load(args.package)
    split = dataset.splits[args.split]
    try:
        package_commit = subprocess.check_output(
            ["git", "-C", str(args.package), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        package_commit = None
    dataset_corpus = load_dataset_corpus(args.dataset_corpus)
    search_corpus = load_search_corpus(args.search_db)
    dataset_digest = corpus_hash(dataset_corpus)
    search_digest = corpus_hash(search_corpus)
    if dataset_corpus != search_corpus:
        raise ValueError(
            "Dataset and Aayatun translation corpora differ: "
            f"{dataset_digest} != {search_digest}"
        )

    cases: list[dict[str, Any]] = []
    query_ids: set[str] = set()
    for group_id, question in sorted(split.questions.items()):
        qrels = dict(sorted(split.qrels[group_id].items()))
        if not any(grade > 0 for grade in qrels.values()):
            raise ValueError(f"{args.split.title()} group {group_id} has no settled positive")
        disputed = sorted(dataset.judged_pairs_for(group_id) - set(qrels))
        missing = (set(qrels) | set(disputed)) - set(dataset_corpus)
        if missing:
            raise ValueError(f"{group_id} references absent ayat: {sorted(missing)}")
        for query in question["queries"]:
            query_id = query["query_id"]
            if query_id in query_ids:
                raise ValueError(f"Duplicate query ID: {query_id}")
            query_ids.add(query_id)
            cases.append(
                {
                    "id": query_id,
                    "group_id": group_id,
                    "query": query["text"],
                    "language": query["language"],
                    "best_settled_label": question["label_summary"][
                        "best_settled_label"
                    ],
                    "compound_status": query["stats"]["compound_status"],
                    "qrels": qrels,
                    "disputed_ayahs": disputed,
                }
            )

    group_counts = Counter(case["group_id"] for case in cases)
    manifest = {
        "dataset_version": dataset.manifest["dataset_version"],
        "package_commit": package_commit,
        "release_status": dataset.manifest["release_status"],
        "benchmark_grade": dataset.manifest["benchmark_grade"],
        "curation_change_required": False,
        "adapter": "External query-level fixture; group-level qrels unchanged.",
        "split": args.split,
        "package_files": {
            relative: text_sha256(args.package / relative)
            for relative in (
                "manifest.json",
                "schema.json",
                "dataset_common.py",
                "load_dataset.py",
                "validate_dataset.py",
                "evaluate_search.py",
                f"{args.split}/questions.jsonl",
                f"{args.split}/grades.jsonl",
            )
        },
        "corpus": {
            "verses": len(dataset_corpus),
            "sha256": dataset_digest,
            "dataset_search_equal": True,
        },
        "counts": {
            "query_cases": len(cases),
            "question_groups": len(group_counts),
            "multi_query_groups": sum(count > 1 for count in group_counts.values()),
            "useful_answerable_cases": sum(
                any(grade >= 2 for grade in case["qrels"].values())
                for case in cases
            ),
            "direct_answerable_cases": sum(
                any(grade == 3 for grade in case["qrels"].values())
                for case in cases
            ),
        },
        "by_language": dict(sorted(Counter(case["language"] for case in cases).items())),
        "by_best_settled_label": dict(
            sorted(Counter(case["best_settled_label"] for case in cases).items())
        ),
        "success_definitions": {
            "positive_hit@5": "At least one settled grade-1, grade-2, or grade-3 ayah in the first five results.",
            "useful_hit@5": "At least one settled grade-2 or grade-3 ayah in the first five results.",
            "direct_hit@5": "At least one settled grade-3 ayah in the first five results.",
        },
        "notes": [
            "Query wordings are evaluation cases; qrels remain question-group level.",
            "Confidence intervals must resample question groups, not query wordings.",
            "The test split is held out but not blind, and labels remain provisional.",
        ],
    }

    output_dir = args.output_dir or (HERE if args.split == "test" else HERE / args.split)
    fixture_path = output_dir / f"islamqa_pr2_{args.split}_queries.jsonl"
    manifest_path = output_dir / f"islamqa_pr2_{args.split}_fixture_manifest.json"
    write_jsonl(fixture_path, cases)
    manifest["fixture_sha256"] = file_sha256(fixture_path)
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, indent=2))


def load_fixture(path: Path, manifest_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cases = read_jsonl(path)
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if file_sha256(path) != manifest["fixture_sha256"]:
        raise ValueError("Fixture hash does not match its manifest")
    if len(cases) != manifest["counts"]["query_cases"]:
        raise ValueError("Fixture case count does not match its manifest")
    return cases, manifest


def verify_package_files(package: Path, manifest: dict[str, Any]) -> None:
    for relative, expected in manifest["package_files"].items():
        actual = text_sha256(package / relative)
        if actual != expected:
            raise ValueError(f"Package hash mismatch for {relative}: {actual} != {expected}")


def materialize_revision(repo: Path, revision: str, destination: Path) -> None:
    paths = [
        "build_search.py",
        "searchnorm.py",
        "searchtool.py",
        "db/quran.db",
        "db/en_quran.db",
        "db/en_kathir.db",
        "db/bn_zakaria.db",
        "db/ai_context.db",
        "db/quran_stat.json",
        "db/search_synonyms.json",
        "db2/quran_metadata.db",
    ]
    archive = subprocess.check_output(
        ["git", "-C", str(repo), "archive", revision, *paths]
    )
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        bundle.extractall(destination, filter="data")


def run_lexical_queries(
    runtime: Path, revision: str, engine_name: str, field: str = "translation",
) -> dict[str, Any]:
    """Run in a child process so Windows releases SQLite handles before cleanup."""
    norm_source = (runtime / "searchnorm.py").read_text(encoding="utf8")
    search_source = (runtime / "searchtool.py").read_text(encoding="utf8")
    norm_module = types.ModuleType("searchnorm")
    norm_module.__file__ = str(runtime / "searchnorm.py")
    exec(
        compile(norm_source, f"{revision}:searchnorm.py", "exec"),
        norm_module.__dict__,
    )
    sys.modules["searchnorm"] = norm_module

    engine = types.ModuleType("islamqa_pr2_lexical")
    engine.__file__ = str(runtime / "searchtool.py")
    exec(
        compile(search_source, f"{revision}:searchtool.py", "exec"),
        engine.__dict__,
    )
    if str(runtime) not in sys.path:
        sys.path.insert(0, str(runtime))
    engine._load_vocab()
    engine._load_bk_tree()
    engine.index_search("mercy", 10, field=field)

    cases = read_jsonl(runtime / "queries.jsonl")
    runs: dict[str, dict[str, Any]] = {}
    for index, case in enumerate(cases):
        started = time.perf_counter()
        hits, _ = engine.index_search(case["query"], 10, field=field)
        elapsed = round((time.perf_counter() - started) * 1000, 3)
        refs = [f"{hit['surah']}:{hit['verse']}" for hit in hits]
        if len(refs) != len(set(refs)):
            raise ValueError(f"Duplicate ayah returned for {case['id']}")
        runs[case["id"]] = {"refs": refs, "ms": elapsed}
        if index % 50 == 0:
            print(f"{engine_name} queries {index}/{len(cases)}", flush=True)
    return runs


def run_lexical(args: argparse.Namespace) -> None:
    cases, fixture_manifest = load_fixture(args.fixture, args.manifest)
    revision = resolve_revision(args.repo, args.revision)
    with tempfile.TemporaryDirectory(prefix=".islamqa-pr2-", dir=WORKSPACE) as temp:
        runtime = Path(temp)
        materialize_revision(args.repo, revision, runtime)
        build = subprocess.run(
            [sys.executable, str(runtime / "build_search.py")],
            cwd=runtime,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        print(build.stdout.strip().splitlines()[-1], flush=True)
        write_jsonl(runtime / "queries.jsonl", cases)
        subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "lexical-queries",
                "--runtime",
                str(runtime),
                "--revision",
                revision,
                "--engine-name",
                args.engine_name,
                "--field",
                args.field,
            ],
            cwd=runtime,
            check=True,
        )
        runs = json.loads((runtime / "runs.json").read_text(encoding="utf8"))

        corpus = load_search_corpus(runtime / "db" / "search.db")
        digest = corpus_hash(corpus)
        if digest != fixture_manifest["corpus"]["sha256"]:
            raise ValueError(
                f"{args.engine_name} index corpus differs from the curated corpus"
            )

        report = {
            "engine": f"Aayatun {args.engine_name} keyword search",
            "revision": revision,
            "searchnorm_blob": git_blob(args.repo, revision, "searchnorm.py"),
            "searchtool_blob": git_blob(args.repo, revision, "searchtool.py"),
            "build_search_blob": git_blob(args.repo, revision, "build_search.py"),
            "en_quran_blob": git_blob(args.repo, revision, "db/en_quran.db"),
            "synonyms_blob": git_blob(args.repo, revision, "db/search_synonyms.json"),
            "runtime_index": "built from pinned revision",
            "search_db_sha256": file_sha256(runtime / "db" / "search.db"),
            "vocab_sha256": file_sha256(runtime / "db" / "search_vocab.pkl"),
            "field": args.field,
            "fixture": args.fixture.name,
            "fixture_sha256": file_sha256(args.fixture),
            "corpus": {"verses": len(corpus), "sha256": digest},
            "runs": runs,
        }
    write_json(args.output, report)
    print(json.dumps({"output": str(args.output), "queries": len(runs)}, indent=2))


def validate_rankings(
    cases: list[dict[str, Any]],
    report: dict[str, Any],
    corpus_refs: set[str],
) -> None:
    expected_ids = {case["id"] for case in cases}
    if set(report["runs"]) != expected_ids:
        missing = sorted(expected_ids - set(report["runs"]))
        extra = sorted(set(report["runs"]) - expected_ids)
        raise ValueError(f"Ranking IDs do not match fixture: missing={missing}, extra={extra}")
    for case_id, run in report["runs"].items():
        refs = run.get("refs")
        if not isinstance(refs, list) or not 1 <= len(refs) <= 10:
            raise ValueError(f"{case_id}: expected one to ten ranked ayat")
        if any(
            not isinstance(ref, str) or not re.fullmatch(r"[1-9]\d*:[1-9]\d*", ref)
            for ref in refs
        ):
            raise ValueError(f"{case_id}: ranking entries must be ayah references")
        if len(refs) != len(set(refs)):
            raise ValueError(f"{case_id}: duplicate ayah in ranking")
        unknown = set(refs) - corpus_refs
        if unknown:
            raise ValueError(f"{case_id}: unknown ayat {sorted(unknown)}")


def first_rank(refs: list[str], predicate: Callable[[str], bool]) -> int:
    return next((rank for rank, ref in enumerate(refs, 1) if predicate(ref)), 0)


def aggregate_metrics(
    cases: list[dict[str, Any]],
    scores: dict[str, dict[str, float]],
    metrics: tuple[str, ...],
) -> dict[str, Any]:
    if not cases:
        raise ValueError("Cannot aggregate an empty slice")
    values = [scores[case["id"]] for case in cases]
    return {
        "queries": len(cases),
        "groups": len({case["group_id"] for case in cases}),
        "metrics": {
            metric: round(statistics.fmean(row[metric] for row in values), 6)
            for metric in metrics
        },
    }


def cluster_delta_ci(
    cases: list[dict[str, Any]],
    baseline: dict[str, dict[str, float]],
    candidate: dict[str, dict[str, float]],
    metric: str,
    samples: int,
    seed: int,
) -> list[float] | None:
    if samples == 0:
        return None
    if samples < 0:
        raise ValueError("Bootstrap sample count must be non-negative")
    by_group: dict[str, list[str]] = defaultdict(list)
    for case in cases:
        by_group[case["group_id"]].append(case["id"])
    group_ids = list(by_group)
    rng = random.Random(seed)
    draws: list[float] = []
    for _ in range(samples):
        total = 0.0
        count = 0
        for group_id in rng.choices(group_ids, k=len(group_ids)):
            for case_id in by_group[group_id]:
                total += candidate[case_id][metric] - baseline[case_id][metric]
                count += 1
        draws.append(total / count)
    ordered = sorted(draws)
    lower = ordered[math.floor(0.025 * (len(ordered) - 1))]
    upper = ordered[math.ceil(0.975 * (len(ordered) - 1))]
    return [round(lower, 6), round(upper, 6)]


def coverage(
    cases: list[dict[str, Any]],
    rankings: dict[str, list[str]],
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for case in cases:
        qrels = set(case["qrels"])
        disputed = set(case["disputed_ayahs"])
        for ayah in rankings[case["id"]]:
            counts["total_results"] += 1
            if ayah in qrels:
                counts["settled_judged_results"] += 1
            elif ayah in disputed:
                counts["disputed_results"] += 1
            else:
                counts["unjudged_results"] += 1
    return dict(counts)


def failure_diagnostics(
    cases: list[dict[str, Any]],
    rankings: dict[str, list[str]],
    scores: dict[str, dict[str, float]],
) -> dict[str, int]:
    failures = [
        case for case in cases if scores[case["id"]]["positive_hit@5"] == 0
    ]
    counts: Counter[str] = Counter()
    for case in failures:
        top5 = rankings[case["id"]][:5]
        qrels = case["qrels"]
        disputed = set(case["disputed_ayahs"])
        if any(qrels.get(ayah) == 0 for ayah in top5):
            counts["with_settled_unrelated_in_top5"] += 1
        if disputed.intersection(top5):
            counts["with_disputed_in_top5"] += 1
        if all(ayah not in qrels and ayah not in disputed for ayah in top5):
            counts["all_top5_unjudged"] += 1
    return {"positive_hit_failures": len(failures), **dict(counts)}


def paired_details(
    cases: list[dict[str, Any]],
    baseline_refs: dict[str, list[str]],
    candidate_refs: dict[str, list[str]],
    baseline_scores: dict[str, dict[str, float]],
    candidate_scores: dict[str, dict[str, float]],
) -> dict[str, Any]:
    rows = []
    for case in cases:
        qrels = case["qrels"]
        baseline_rank = first_rank(
            baseline_refs[case["id"]],
            lambda ref: qrels.get(ref, 0) >= 2,
        )
        candidate_rank = first_rank(
            candidate_refs[case["id"]],
            lambda ref: qrels.get(ref, 0) >= 2,
        )
        rows.append(
            {
                "id": case["id"],
                "group_id": case["group_id"],
                "query": case["query"],
                "language": case["language"],
                "best_settled_label": case["best_settled_label"],
                "baseline_useful_rank": baseline_rank,
                "candidate_useful_rank": candidate_rank,
                "baseline_useful_hit@5": baseline_scores[case["id"]]["useful_hit@5"],
                "candidate_useful_hit@5": candidate_scores[case["id"]]["useful_hit@5"],
                "baseline_positive_hit@5": baseline_scores[case["id"]]["positive_hit@5"],
                "candidate_positive_hit@5": candidate_scores[case["id"]]["positive_hit@5"],
            }
        )
    wins = [row for row in rows if row["candidate_useful_hit@5"] > row["baseline_useful_hit@5"]]
    losses = [row for row in rows if row["candidate_useful_hit@5"] < row["baseline_useful_hit@5"]]
    ties = [row for row in rows if row["candidate_useful_hit@5"] == row["baseline_useful_hit@5"]]
    regressions = [
        row
        for row in rows
        if row["baseline_useful_rank"]
        and (
            not row["candidate_useful_rank"]
            or row["candidate_useful_rank"] > row["baseline_useful_rank"]
        )
    ]
    return {
        "useful_hit@5": {
            "wins": len(wins),
            "losses": len(losses),
            "ties": len(ties),
            "gained_cases": wins,
            "lost_cases": losses,
            "rank_regressions": regressions,
        }
    }


def markdown_table(
    rows: list[tuple[str, list[dict[str, Any]], dict[str, dict[str, Any]]]],
    metric: str,
) -> str:
    lines = [
        f"| Test slice | Queries | Deploy {metric} | FCS {metric} | PR #2 meaning {metric} | FCS - Deploy | PR #2 - FCS |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for label, cases, values in rows:
        deploy_value = values["deploy"]["metrics"][metric]
        fcs_value = values["fcs"]["metrics"][metric]
        meaning_value = values["meaning"]["metrics"][metric]
        lines.append(
            f"| {label} | {len(cases)} | {deploy_value:.1%} | "
            f"{fcs_value:.1%} | {meaning_value:.1%} | "
            f"{(fcs_value - deploy_value) * 100:+.1f} pp | "
            f"{(meaning_value - fcs_value) * 100:+.1f} pp |"
        )
    return "\n".join(lines)


def metric_comparison(
    cases: list[dict[str, Any]],
    baseline_name: str,
    candidate_name: str,
    scores: dict[str, dict[str, dict[str, float]]],
    metric: str,
    samples: int,
    seed: int,
) -> dict[str, Any]:
    baseline = scores[baseline_name]
    candidate = scores[candidate_name]
    return {
        "queries": len(cases),
        "delta_mean": round(
            statistics.fmean(
                candidate[case["id"]][metric] - baseline[case["id"]][metric]
                for case in cases
            ),
            6,
        ),
        "delta_ci95": cluster_delta_ci(
            cases, baseline, candidate, metric, samples, seed
        ),
        "bootstrap": {
            "samples": samples,
            "seed": seed,
            "method": "paired_percentile_question_group_resampling",
        },
    }


def score(args: argparse.Namespace) -> None:
    cases, fixture_manifest = load_fixture(args.fixture, args.manifest)
    verify_package_files(args.package, fixture_manifest)
    _, metrics, score_group = package_modules(args.package)
    deploy = json.loads(args.deploy.read_text(encoding="utf8"))
    fcs = json.loads(args.fcs.read_text(encoding="utf8"))
    meaning = json.loads(args.meaning.read_text(encoding="utf8"))
    reports = {"deploy": deploy, "fcs": fcs, "meaning": meaning}
    expected_revisions = {
        "deploy": ("revision", DEPLOY_REVISION),
        "fcs": ("revision", BASELINE_REVISION),
        "meaning": ("product_commit", PR_REVISION),
    }
    for name, (key, expected) in expected_revisions.items():
        if reports[name][key] != expected:
            raise ValueError(
                f"{name} revision mismatch: expected {expected}, "
                f"got {reports[name][key]}"
            )
    for name, expected_blobs in LEXICAL_BLOBS.items():
        if reports[name].get("field") != "translation":
            raise ValueError(f"{name} lexical field must be translation")
        for key, expected in expected_blobs.items():
            if reports[name].get(key) != expected:
                raise ValueError(f"{name} {key} does not match the pinned revision")
    for key, expected in MEANING_ASSET_SHA256.items():
        if meaning.get(key) != expected:
            raise ValueError(f"meaning {key} does not match the pinned PR assets")
    if meaning.get("model_files") != MEANING_MODEL_FILES:
        raise ValueError("meaning model_files does not match the pinned local E5 mirror")
    expected_corpus = fixture_manifest["corpus"]["sha256"]
    for name, report in reports.items():
        if report["fixture_sha256"] != file_sha256(args.fixture):
            raise ValueError(f"{name} report fixture hash mismatch")
        report_corpus = (
            report["corpus"]
            if name == "meaning"
            else report["corpus"]["sha256"]
        )
        if report_corpus != expected_corpus:
            raise ValueError(f"{name} corpus hash mismatch")
    dataset_corpus = load_dataset_corpus(args.dataset_corpus)
    if corpus_hash(dataset_corpus) != expected_corpus:
        raise ValueError("Tracked translation corpus does not match the fixture")
    corpus_refs = set(dataset_corpus)
    for report in reports.values():
        validate_rankings(cases, report, corpus_refs)
    scores = {
        name: {
            case["id"]: score_group(report["runs"][case["id"]]["refs"], case["qrels"])
            for case in cases
        }
        for name, report in reports.items()
    }
    rankings = {
        name: {case_id: run["refs"] for case_id, run in report["runs"].items()}
        for name, report in reports.items()
    }

    useful_cases = [
        case for case in cases if any(grade >= 2 for grade in case["qrels"].values())
    ]
    slices = [
        ("All test queries", cases),
        ("English", [case for case in cases if case["language"] == "en"]),
        ("Other languages", [case for case in cases if case["language"] != "en"]),
        ("Direct-answer groups", [case for case in cases if case["best_settled_label"] == "direct"]),
        ("Partial-answer groups", [case for case in cases if case["best_settled_label"] == "partial"]),
        ("Background-only groups", [case for case in cases if case["best_settled_label"] == "background"]),
    ]
    slice_reports = {}
    positive_rows = []
    useful_rows = []
    for label, selected in slices:
        if not selected:
            continue
        values = {
            name: aggregate_metrics(selected, scores[name], metrics)
            for name in reports
        }
        slice_reports[label] = values
        positive_rows.append((label, selected, values))
        useful_selected = [
            case for case in selected if any(grade >= 2 for grade in case["qrels"].values())
        ]
        if useful_selected:
            useful_rows.append(
                (
                    "All useful-answerable" if label == "All test queries" else label,
                    useful_selected,
                    {
                        name: aggregate_metrics(useful_selected, scores[name], metrics)
                        for name in reports
                    },
                )
            )

    comparisons = {}
    for baseline_name, candidate_name in (("deploy", "fcs"), ("fcs", "meaning")):
        comparisons[f"{candidate_name}_vs_{baseline_name}"] = {
            "positive_hit@5": metric_comparison(
                cases,
                baseline_name,
                candidate_name,
                scores,
                "positive_hit@5",
                args.bootstrap,
                args.seed,
            ),
            "useful_hit@5": metric_comparison(
                useful_cases,
                baseline_name,
                candidate_name,
                scores,
                "useful_hit@5",
                args.bootstrap,
                args.seed,
            ),
            "useful_case_details": paired_details(
                useful_cases,
                rankings[baseline_name],
                rankings[candidate_name],
                scores[baseline_name],
                scores[candidate_name],
            )["useful_hit@5"],
        }
    for name in reports:
        write_jsonl(
            args.output_dir / f"islamqa_pr2_{name}_query_rankings.jsonl",
            (
                {
                    "id": case["id"],
                    "group_id": case["group_id"],
                    "query": case["query"],
                    "ranking": rankings[name][case["id"]],
                }
                for case in cases
            ),
        )

    timings = {}
    for name, report in reports.items():
        timed_cases = cases[1:] if name == "meaning" else cases
        timings[name] = sorted(
            report["runs"][case["id"]]["ms"] for case in timed_cases
        )
    result = {
        "fixture": args.fixture.name,
        "fixture_sha256": file_sha256(args.fixture),
        "fixture_manifest": fixture_manifest,
        "evaluation": {
            "scorer_sha256": text_sha256(Path(__file__)),
            "browser_harness_sha256": text_sha256(HERE / "islamqa_pr2_browser.cjs"),
        },
        "product": {
            "deploy_revision": deploy["revision"],
            "fcs_revision": fcs["revision"],
            "candidate_revision": meaning["product_commit"],
            "candidate_worker_sha256": meaning["worker_sha256"],
            "candidate_index_sha256": meaning["index_sha256"],
            "candidate_vectors_sha256": meaning["vectors_sha256"],
            "candidate_model_config_sha256": meaning["model_config_sha256"],
            "candidate_model_tokenizer_sha256": meaning["model_tokenizer_sha256"],
            "candidate_model_tokenizer_config_sha256": meaning[
                "model_tokenizer_config_sha256"
            ],
            "candidate_model_weights_sha256": meaning["model_weights_sha256"],
        },
        "success_definition": fixture_manifest["success_definitions"],
        "slices": slice_reports,
        "overall": {
            name: aggregate_metrics(cases, scores[name], metrics)
            for name in reports
        },
        "comparisons": comparisons,
        "coverage": {
            name: coverage(cases, rankings[name]) for name in reports
        },
        "failure_diagnostics": {
            name: failure_diagnostics(cases, rankings[name], scores[name])
            for name in reports
        },
        "timings_ms": {
            name: {
                "p50": values[math.ceil(0.50 * len(values)) - 1],
                "p95": values[math.ceil(0.95 * len(values)) - 1],
                "basis": (
                    "warmed browser queries; cold first query excluded"
                    if name == "meaning"
                    else "local Python queries after one warm-up call"
                ),
            }
            for name, values in timings.items()
        },
        "tables": {
            "positive_hit@5": markdown_table(positive_rows, "positive_hit@5"),
            "useful_hit@5": markdown_table(useful_rows, "useful_hit@5"),
        },
        "limitations": [
            "The IslamQA package is provisional and not benchmark-grade.",
            "Test questions were visible during model-assisted review; the split is not blind.",
            "Relevance labels and citation corrections lack independent scholarly review.",
            "Pooled judgments are incomplete; unjudged results earn no gain.",
            "Deploy and FCS search are constrained to the English translation field for a same-corpus comparison.",
            "Meaning-search timings use a warmed browser worker and a local static model mirror.",
            "Local Python and browser-worker timings are not production-latency comparisons.",
        ],
    }
    write_json(args.output, result)
    print(result["tables"]["positive_hit@5"])
    print()
    print(result["tables"]["useful_hit@5"])
    print()
    summary_comparisons = {
        name: {
            "positive_hit@5": comparison["positive_hit@5"],
            "useful_hit@5": comparison["useful_hit@5"],
            "useful_case_counts": {
                key: len(value) if isinstance(value, list) else value
                for key, value in comparison["useful_case_details"].items()
            },
        }
        for name, comparison in comparisons.items()
    }
    print(
        json.dumps(
            {"comparisons": summary_comparisons, "output": str(args.output)},
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare", help="Flatten the test split")
    prepare_parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    prepare_parser.add_argument(
        "--dataset-corpus",
        type=Path,
        default=WORKSPACE / "aayatun-research" / "db" / "en_quran.db",
    )
    prepare_parser.add_argument(
        "--search-db", type=Path, default=DEFAULT_REPO / "db" / "search.db"
    )
    prepare_parser.add_argument("--split", choices=("validation", "test"), default="test")
    prepare_parser.add_argument("--output-dir", type=Path)
    prepare_parser.set_defaults(func=prepare)

    lexical_parser = subparsers.add_parser("lexical", help="Run a pinned lexical revision")
    lexical_parser.add_argument("--fixture", type=Path, default=HERE / FIXTURE_NAME)
    lexical_parser.add_argument("--manifest", type=Path, default=HERE / MANIFEST_NAME)
    lexical_parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    lexical_parser.add_argument("--revision", default=BASELINE_REVISION)
    lexical_parser.add_argument("--engine-name", default="latest pushed FCS")
    lexical_parser.add_argument("--field", choices=("translation", "all"), default="translation")
    lexical_parser.add_argument("--output", type=Path, default=HERE / FCS_NAME)
    lexical_parser.set_defaults(func=run_lexical)

    query_parser = subparsers.add_parser("lexical-queries", help=argparse.SUPPRESS)
    query_parser.add_argument("--runtime", type=Path, required=True)
    query_parser.add_argument("--revision", required=True)
    query_parser.add_argument("--engine-name", required=True)
    query_parser.add_argument("--field", choices=("translation", "all"), default="translation")
    query_parser.set_defaults(func=lambda args: write_json(
        args.runtime / "runs.json",
        run_lexical_queries(args.runtime, args.revision, args.engine_name, args.field),
    ))


    score_parser = subparsers.add_parser("score", help="Score deploy, FCS, and meaning runs")
    score_parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    score_parser.add_argument("--fixture", type=Path, default=HERE / FIXTURE_NAME)
    score_parser.add_argument("--manifest", type=Path, default=HERE / MANIFEST_NAME)
    score_parser.add_argument("--deploy", type=Path, default=HERE / DEPLOY_NAME)
    score_parser.add_argument("--fcs", type=Path, default=HERE / FCS_NAME)
    score_parser.add_argument("--meaning", type=Path, default=HERE / MEANING_NAME)
    score_parser.add_argument(
        "--dataset-corpus",
        type=Path,
        default=WORKSPACE / "aayatun-research" / "db" / "en_quran.db",
    )
    score_parser.add_argument("--output-dir", type=Path, default=HERE)
    score_parser.add_argument("--output", type=Path, default=HERE / RESULTS_NAME)
    score_parser.add_argument("--bootstrap", type=int, default=2000)
    score_parser.add_argument("--seed", type=int, default=4213)
    score_parser.set_defaults(func=score)

    args = parser.parse_args()
    if hasattr(args, "bootstrap") and args.bootstrap < 0:
        parser.error("--bootstrap must be non-negative")
    args.func(args)


if __name__ == "__main__":
    main()
