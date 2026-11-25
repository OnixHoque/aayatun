"""Compare keyword-search revisions on the existing Aayatun fixtures."""
import argparse
from collections import defaultdict
import hashlib
from functools import lru_cache
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
FIELD_CORPUS_COLUMNS = {
    "all": ("ar_norm", "en_norm", "ai_norm", "en_tafsir_norm", "bn_tafsir_norm", "surah_name"),
    "ayah": ("ar_norm",),
    "translation": ("en_norm",),
    "en_tafsir": ("en_tafsir_norm",),
    "bn_tafsir": ("bn_tafsir_norm",),
    "ai": ("ai_norm",),
}


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
        head = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
        ).strip()
        return head + "+worktree"
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


def build_corpora(repo):
    from searchnorm import normalize

    corpora = {field: {} for field in FIELD_CORPUS_COLUMNS}
    refs_by_rowid = {}
    with sqlite3.connect(f"{(repo / 'db/search.db').as_uri()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        for row in db.execute("SELECT rowid, surah, verse, * FROM docs"):
            ref = f"{row['surah']}:{row['verse']}"
            refs_by_rowid[row['rowid']] = ref
            for field, columns in FIELD_CORPUS_COLUMNS.items():
                tokens = set()
                for column in columns:
                    text, _ = normalize(row[column] or "")
                    tokens.update(text.split())
                corpora[field][ref] = tokens
        if db.execute(
                "SELECT 1 FROM sqlite_master WHERE name='english_stem'").fetchone():
            db.execute("CREATE VIRTUAL TABLE temp.stem_vocab "
                       "USING fts5vocab(main, english_stem, 'instance')")
            stem_fields = {'en_norm': 'translation', 'ai_norm': 'ai',
                           'en_tafsir_norm': 'en_tafsir'}
            for term, doc, column in db.execute(
                    "SELECT term, doc, col FROM stem_vocab"):
                ref = refs_by_rowid.get(doc)
                if ref is None or column not in stem_fields:
                    continue
                corpora['all'][ref].add(term)
                corpora[stem_fields[column]][ref].add(term)
    return corpora


def build_corpus(repo):
    """Return the All-fields token corpus for compatibility."""
    return build_corpora(repo)["all"]


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


_PORTER_DB = None


@lru_cache(maxsize=None)
def porter_term(term):
    """Return SQLite's Porter stem so coverage matches FCS term masks."""
    global _PORTER_DB
    if _PORTER_DB is None:
        _PORTER_DB = sqlite3.connect(':memory:')
        _PORTER_DB.execute("CREATE VIRTUAL TABLE porter_terms USING fts5("
                           "term, tokenize='porter unicode61')")
        _PORTER_DB.execute("CREATE VIRTUAL TABLE porter_vocab "
                           "USING fts5vocab(porter_terms, 'instance')")
    _PORTER_DB.execute('DELETE FROM porter_terms')
    _PORTER_DB.execute('INSERT INTO porter_terms VALUES (?)', (term,))
    row = _PORTER_DB.execute('SELECT term FROM porter_vocab').fetchone()
    return row[0] if row else term


def coverage_at_five(case, refs, corpus):
    terms = query_terms(case)
    if not terms:
        return None
    covered = set()
    for ref in refs[:5]:
        tokens = corpus.get(ref, set())
        for term in terms:
            stem = porter_term(term)
            if (term in tokens or stem in tokens or
                    (len(term) >= 4 and any(token.startswith(term) for token in tokens))):
                covered.add(term)
    return len(covered) / len(terms)


def first_rank(refs, expected):
    return next((rank for rank, ref in enumerate(refs, 1) if ref in expected), 0)


def group_keys(case, field=None):
    keys = ["all"]
    for key in ("split", "intent", "kind", "provenance", "language"):
        if case.get(key):
            keys.append(f"{key}={case[key]}")
    terms = query_terms(case)
    if terms:
        keys.append("coverage_english_multi")
        scope = field or case.get("field") or "all"
        if scope == "all":
            keys.append("coverage_english_multi_all")
        else:
            keys.append(f"coverage_english_multi_{scope}")
    return keys


def summarize(cases, runs, engine, corpora, field_override=None):
    groups = defaultdict(list)
    for case in cases:
        expected = anchors(case)
        if not expected:
            continue
        refs = runs[case["id"]][engine]["results"]
        rank = first_rank(refs, expected)
        field = field_override or case.get("field") or "all"
        coverage = coverage_at_five(case, refs, corpora[field])
        for key in group_keys(case, field):
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
    parser.add_argument(
        "--field", choices=["all", "ayah", "translation", "en_tafsir", "bn_tafsir", "ai"],
        help="Override the fixture field scope for generalized regression runs")
    parser.add_argument(
        "--english-multi", action="store_true",
        help="Keep only plain-English multi-keyword cases eligible for FCS")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    benchmark_dir = args.benchmark_dir.resolve()
    os.chdir(repo)
    sys.path.insert(0, str(repo))
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
    if args.english_multi:
        cases = [case for case in cases if query_terms(case)]
    if not cases:
        raise ValueError("No plain-English multi-keyword cases remain")

    revisions = {
        "baseline": resolve_revision(repo, args.baseline),
        "candidate": resolve_revision(repo, args.candidate),
    }
    engines = {
        "baseline": load_engine(repo, args.baseline),
        "candidate": load_engine(repo, args.candidate),
    }
    corpora = build_corpora(repo)
    runs = {}
    for index, case in enumerate(cases):
        order = ["baseline", "candidate"] if index % 2 == 0 else ["candidate", "baseline"]
        runs[case["id"]] = {}
        field = args.field or case["field"]
        for name in order:
            started = time.perf_counter()
            hits, _ = engines[name].index_search(case["query"], TOP_K, field=field)
            elapsed = (time.perf_counter() - started) * 1000
            runs[case["id"]][name] = {
                "results": [f"{hit['surah']}:{hit['verse']}" for hit in hits],
                "ms": round(elapsed, 3),
            }
        if index % 100 == 0:
            print(args.fixture, args.split, index, "/", len(cases), flush=True)

    metrics = {
        name: summarize(cases, runs, name, corpora, args.field) for name in engines
    }
    regressions = rank_regressions(cases, runs, "baseline", "candidate")
    top_five_losses = [
        row for row in regressions
        if row["baseline_rank"] <= 5 and
        (not row["candidate_rank"] or row["candidate_rank"] > 5)
    ]
    report = {
        "fixture": args.fixture,
        "fixture_sha256": hashlib.sha256(data).hexdigest(),
        "split": args.split,
        "field_override": args.field,
        "english_multi_only": args.english_multi,
        "revisions": revisions,
        "metrics": metrics,
        "regressions": regressions,
        "top_five_losses": top_five_losses,
        "runs": [
            {"id": case["id"], "query": case["query"],
             "field": args.field or case["field"], "rankings": runs[case["id"]]}
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
        "scoped_coverage": {
            name: {key: value for key, value in values.items()
                   if key.startswith("coverage_english_multi_")}
            for name, values in metrics.items()
        },
        "latency": {name: values["latency"] for name, values in metrics.items()},
        "rank_regressions": len(regressions),
        "top_five_losses": len(top_five_losses),
    }, indent=2))


if __name__ == "__main__":
    main()
