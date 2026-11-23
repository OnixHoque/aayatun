"""Resolve browser-ranked verse references against the current translation index."""
import hashlib
import json
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import searchtool


def corpus_hash(rows):
    verses = {f"{surah}:{verse}": text for surah, verse, text in rows}
    return hashlib.sha256(json.dumps(verses, sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=1)
def _translation_index(file_version):
    with closing(searchtool._connect()) as conn:
        rows = conn.execute("SELECT surah, verse, en, rowid FROM docs").fetchall()
    return corpus_hash((s, v, text) for s, v, text, _ in rows), {
        f"{s}:{v}": rowid for s, v, _, rowid in rows
    }


def search(refs, browser_corpus):
    meta = {"suggestions": [], "corrected": None, "truncated": False, "error": None}
    if not 1 <= len(refs) <= 10 or len(set(refs)) != len(refs):
        meta["error"] = "Meaning search could not load its results. Try again or choose keyword search."
        return [], meta

    searchtool._ensure_db()
    stat = Path(searchtool._DB).stat()
    digest, rowids = _translation_index((stat.st_ino, stat.st_mtime_ns, stat.st_size))
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
    return searchtool._format([rows[rowid] for rowid in ids], []), meta
