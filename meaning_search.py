"""Resolve browser-ranked references against the selected semantic corpus."""
import hashlib
import json
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import searchtool


ALL_FIELDS = (
    "ar_raw", "en", "en_tafsir", "bn_tafsir",
    "verse_context", "word_meanings", "surah_name",
)


def corpus_hash(rows):
    verses = {f"{surah}:{verse}": text for surah, verse, text in rows}
    return hashlib.sha256(json.dumps(verses, sort_keys=True).encode()).hexdigest()


def field_hash(rows, field):
    verses = {f"{row['surah']}:{row['verse']}": row[field] for row in rows}
    return hashlib.sha256(json.dumps(verses, sort_keys=True).encode()).hexdigest()


def all_fields_hash(rows):
    verses = {
        f"{row['surah']}:{row['verse']}": {field: row[field] for field in ALL_FIELDS}
        for row in rows
    }
    return hashlib.sha256(json.dumps(verses, sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=1)
def _translation_index(file_version):
    with closing(searchtool._connect()) as conn:
        rows = conn.execute("SELECT surah, verse, en, rowid FROM docs").fetchall()
    return corpus_hash((s, v, text) for s, v, text, _ in rows), {
        f"{s}:{v}": rowid for s, v, _, rowid in rows
    }


def _search_display_matches(rows, indexed, expected_count: int = 6236) -> bool:
    source_rows = {f"{row['surah']}:{row['verse']}": row for row in rows}
    refs = set(source_rows)
    indexed_refs = {f"{surah}:{verse}" for surah, verse, *_ in indexed}
    if len(rows) != expected_count or len(indexed) != expected_count or refs != indexed_refs:
        return False
    for surah, verse, _, ar_orig, en, surah_name in indexed:
        source = source_rows[f"{surah}:{verse}"]
        if (ar_orig, en, surah_name) != (source["ar_raw"], source["en"], source["surah_name"]):
            return False
    return True


@lru_cache(maxsize=1)
def _all_fields_index(file_version):
    from build_search import load_rows

    rows = load_rows()
    with closing(searchtool._connect()) as conn:
        indexed = conn.execute(
            "SELECT surah, verse, rowid, ar_orig, en, surah_name FROM docs"
        ).fetchall()
    if not _search_display_matches(rows, indexed):
        return None, None
    rowids = {f"{surah}:{verse}": rowid for surah, verse, rowid, _, _, _ in indexed}
    return all_fields_hash(rows), rowids


def _frozen_all_fields_manifest():
    path = Path(__file__).resolve().parent / "static" / "meaning" / "all-fields-index.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None
    if manifest.get("scope") != "all-fields" or manifest.get("schema_version") != 2:
        return None
    if manifest.get("fusion", {}).get("status") != "frozen":
        return None
    return manifest


def _file_version(paths):
    version = []
    for path in paths:
        stat = Path(path).stat()
        version.append((stat.st_ino, stat.st_mtime_ns, stat.st_size))
    return tuple(version)


def search(refs, browser_corpus, scope="translation"):
    meta = {"suggestions": [], "corrected": None, "truncated": False, "error": None, "scope": scope}
    refs = list(refs or [])
    if scope not in ("translation", "all-fields"):
        meta["error"] = "Unknown meaning-search scope. Choose keyword search."
        return [], meta
    if not 1 <= len(refs) <= 10 or len(set(refs)) != len(refs) or any(not isinstance(ref, str) for ref in refs):
        meta["error"] = "Meaning search could not load its results. Try again or choose keyword search."
        return [], meta

    try:
        searchtool._ensure_db()
        if scope == "translation":
            stat = Path(searchtool._DB).stat()
            digest, rowids = _translation_index((stat.st_ino, stat.st_mtime_ns, stat.st_size))
        else:
            version = _file_version((
                searchtool._DB, "db/quran.db", "db/en_quran.db", "db/en_kathir.db",
                "db/bn_zakaria.db", "db/ai_context.db", "db/quran_stat.json",
            ))
            digest, rowids = _all_fields_index(version)
    except (OSError, ValueError, sqlite3.Error):
        meta["error"] = "The meaning-search index needs refreshing. Keyword search is available."
        return [], meta
    if scope == "all-fields":
        manifest = _frozen_all_fields_manifest()
        if digest is None or rowids is None or not manifest or manifest.get("corpus") != digest:
            meta["error"] = "The meaning-search index needs refreshing. Keyword search is available."
            return [], meta
    if browser_corpus != digest or any(ref not in rowids for ref in refs):
        meta["error"] = "The meaning-search index needs refreshing. Keyword search is available."
        return [], meta

    ids = [rowids[ref] for ref in refs]
    placeholders = ",".join("?" for _ in ids)
    with closing(searchtool._connect()) as conn:
        rows = {row["rowid"]: row for row in conn.execute(
            f"SELECT rowid, surah, verse, surah_name, ar_orig, en FROM docs "
            f"WHERE rowid IN ({placeholders})", ids)}
    if any(rowid not in rows for rowid in ids):
        meta["error"] = "The meaning-search index needs refreshing. Keyword search is available."
        return [], meta
    results = searchtool._format([rows[rowid] for rowid in ids], [])
    if scope == 'all-fields':
        with closing(sqlite3.connect('db/en_kathir.db')) as tafsir_db, \
                closing(sqlite3.connect('db/ai_context.db')) as ai_db:
            from build_search import strip_markup
            for item in results:
                s, v = item['surah'], item['verse']
                tafsir = tafsir_db.execute(
                    'SELECT tafsir_text FROM tafsir_kathir WHERE surah=? AND ayah=?', (s, v)).fetchone()
                context = ai_db.execute(
                    'SELECT content FROM verse_analysis WHERE surah=? AND verse=?', (s, v - 1)).fetchone()
                item['semantic_tafsir'] = strip_markup(tafsir[0]) if tafsir else ''
                try:
                    item['semantic_ai'] = json.loads(context[0]).get('verse_context', '') if context else ''
                except (ValueError, TypeError):
                    item['semantic_ai'] = ''
                item['chips'] = ['Translation']
                if item['semantic_tafsir']:
                    item['chips'].append('Tafsir Ibn Kathir')
                if item['semantic_ai']:
                    item['chips'].append('AI explanation')
    return results, meta
