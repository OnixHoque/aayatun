"""Compare keyword-search revisions on the existing Aayatun fixtures."""
import argparse
from collections import defaultdict
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import types


HERE = Path(__file__).resolve().parent
TOP_K = 10
PLAIN_ENGLISH = re.compile(r"[A-Za-z]+(?:\s+[A-Za-z]+){1,11}")


def read_cases(path):
    cases = [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("Fixture contains duplicate case IDs")
    return cases


def anchors(case):
    expected = set(case.get("expected") or [])
    if expected:
        return expected
    return {ref for ref, grade in case.get("judgments", {}).items() if grade == 2}


def resolve_revision(repo, revision):
    if revision == "worktree":
        return subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
        ).strip()
    return subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", revision], text=True
    ).strip()


def load_engine(repo, revision):
    if revision == "worktree":
        path = repo / "searchtool.py"
        spec = importlib.util.spec_from_file_location("keyword_candidate", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    else:
        source = subprocess.check_output(
            ["git", "-C", str(repo), "show", f"{revision}:searchtool.py"]
        ).decode("utf8")
        module = types.ModuleType("keyword_revision")
        module.__file__ = str(repo / "searchtool.py")
        exec(compile(source, f"{revision}:searchtool.py", "exec"), module.__dict__)
    module.index_search("mercy", TOP_K)
    module._load_vocab()
    module._load_bk_tree()
    return module


def build_corpus(repo):
    from searchnorm import normalize

    columns = ("ar_norm", "en_norm", "ai_norm", "en_tafsir_norm", "bn_tafsir_norm", "surah_name")
    corpus = {}
    with sqlite3.connect(f"{(repo / 'db/search.db').as_uri()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        for row in db.execute(
            "SELECT surah, verse, " + ", ".join(columns) + " FROM docs"
        ):
            tokens = set()
            for column in columns:
                text, _ = normalize(row[column] or "")
                tokens.update(text.split())
            corpus[f"{row['surah']}:{row['verse']}"] = tokens
    return corpus


def query_terms(case):
    is_multi = case.get("intent") == "multi" or case.get("kind") is not None
    if not is_multi or case.get("language") not in (None, "en"):
        return []
    raw = case["query"].strip()
    if not PLAIN_ENGLISH.fullmatch(raw):
        return []
    from searchnorm import normalize

    normalized, _ = normalize(raw)
    return normalized.split()


def coverage_at_five(case, refs, corpus):
    terms = query_terms(case)
    if not terms:
        return None
    covered = set()
    for ref in refs[:5]:
        tokens = corpus.get(ref, set())
        for term in terms:
            if term in tokens or (len(term) >= 4 and any(token.startswith(term) for token in tokens)):
                covered.add(term)
    return len(covered) / len(terms)


def first_rank(refs, expected):
    return next((rank for rank, ref in enumerate(refs, 1) if ref in expected), 0)


def group_keys(case):
    keys = ["all"]
    for field in ("split", "intent", "kind", "provenance", "language"):
        if case.get(field):
            keys.append(f"{field}={case[field]}")
    terms = query_terms(case)
    if terms:
        keys.append("coverage_english_multi")
        if case.get("field") == "all":
            keys.append("coverage_english_multi_all")
    return keys


def summarize(cases, runs, engine, corpus):
    groups = defaultdict(list)
    for case in cases:
        expected = anchors(case)
        if not expected:
            continue
        refs = runs[case["id"]][engine]["results"]
        rank = first_rank(refs, expected)
        coverage = coverage_at_five(case, refs, corpus)
        for key in group_keys(case):
            groups[key].append((rank, coverage))
    summary = {}
    for key, rows in groups.items():
        ranks = [rank for rank, _ in rows]
        coverages = [coverage for _, coverage in rows if coverage is not None]
        summary[key] = {
            "n": len(rows),
            "hit_at_5": sum(0 < rank <= 5 for rank in ranks) / len(ranks),
            "mrr_at_10": sum(1 / rank if rank else 0 for rank in ranks) / len(ranks),
            "coverage_n": len(coverages),
            "coverage_at_5": sum(coverages) / len(coverages) if coverages else None,
        }
    timings = sorted(runs[case["id"]][engine]["ms"] for case in cases)
    summary["latency"] = {
        "n": len(timings),
        "p50_ms": timings[math.ceil(.50 * len(timings)) - 1],
        "p95_ms": timings[math.ceil(.95 * len(timings)) - 1],
    }
    return summary


def rank_regressions(cases, runs, baseline, candidate):
    regressions = []
    for case in cases:
        expected = anchors(case)
        if not expected:
            continue
        baseline_refs = runs[case["id"]][baseline]["results"]
        candidate_refs = runs[case["id"]][candidate]["results"]
        baseline_rank = first_rank(baseline_refs, expected)
        candidate_rank = first_rank(candidate_refs, expected)
        if baseline_rank and (not candidate_rank or candidate_rank > baseline_rank):
            regressions.append({
                "id": case["id"],
                "query": case["query"],
                "baseline_rank": baseline_rank,
                "candidate_rank": candidate_rank,
            })
    return regressions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--benchmark-dir", type=Path, required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", default="HEAD")
    parser.add_argument("--fixture", default="challenge_v2.jsonl")
    parser.add_argument("--split", default="all")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    benchmark_dir = args.benchmark_dir.resolve()
    fixture = benchmark_dir / args.fixture
    data = fixture.read_bytes()
    manifest_path = benchmark_dir / "challenge_manifest.json"
    if args.fixture == "challenge_v2.jsonl" and manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf8"))
        if hashlib.sha256(data).hexdigest() != manifest["query_sha256"]:
            raise ValueError("Challenge fixture hash does not match its manifest")
    cases = read_cases(fixture)
    if args.split != "all":
        cases = [case for case in cases if case.get("split") == args.split]
    if not cases:
        raise ValueError("No cases remain after applying the requested split")

    os.chdir(repo)
    sys.path.insert(0, str(repo))
    revisions = {
        "baseline": resolve_revision(repo, args.baseline),
        "candidate": resolve_revision(repo, args.candidate),
    }
    engines = {
        "baseline": load_engine(repo, args.baseline),
        "candidate": load_engine(repo, args.candidate),
    }
    corpus = build_corpus(repo)
    runs = {}
    for index, case in enumerate(cases):
        order = ["baseline", "candidate"] if index % 2 == 0 else ["candidate", "baseline"]
        runs[case["id"]] = {}
        for name in order:
            started = time.perf_counter()
            hits, _ = engines[name].index_search(case["query"], TOP_K, field=case["field"])
            elapsed = (time.perf_counter() - started) * 1000
            runs[case["id"]][name] = {
                "results": [f"{hit['surah']}:{hit['verse']}" for hit in hits],
                "ms": round(elapsed, 3),
            }
        if index % 100 == 0:
            print(args.fixture, args.split, index, "/", len(cases), flush=True)

    metrics = {
        name: summarize(cases, runs, name, corpus) for name in engines
    }
    regressions = rank_regressions(cases, runs, "baseline", "candidate")
    report = {
        "fixture": args.fixture,
        "fixture_sha256": hashlib.sha256(data).hexdigest(),
        "split": args.split,
        "revisions": revisions,
        "metrics": metrics,
        "regressions": regressions,
        "runs": [
            {"id": case["id"], "query": case["query"], "field": case["field"],
             "rankings": runs[case["id"]]}
            for case in cases
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "revisions": revisions,
        "all": {name: values["all"] for name, values in metrics.items()},
        "coverage_english_multi": {
            name: values.get("coverage_english_multi") for name, values in metrics.items()
        },
        "coverage_english_multi_all": {
            name: values.get("coverage_english_multi_all") for name, values in metrics.items()
        },
        "latency": {name: values["latency"] for name, values in metrics.items()},
        "rank_regressions": len(regressions),
    }, indent=2))


if __name__ == "__main__":
    main()
