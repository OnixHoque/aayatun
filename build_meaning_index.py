"""Build browser search assets offline with cached multilingual E5-small weights."""
import json
from pathlib import Path
import sqlite3
from contextlib import closing

from meaning_search import corpus_hash

MODEL = "intfloat/multilingual-e5-small"
REVISION = "c007d7ef6fd86656326059b28395a7a03a7c5846"


def main():
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    database = Path("db/search.db").resolve()
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        rows = conn.execute("SELECT surah, verse, en FROM docs ORDER BY surah, verse").fetchall()
    if len(rows) != 6236 or any(not text for _, _, text in rows):
        raise ValueError("Expected the complete English translation index")

    options = {"revision": REVISION, "local_files_only": True}
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL, **options)
    encoder = AutoModel.from_pretrained(MODEL, **options).eval().to(device)
    vectors = np.empty((len(rows), encoder.config.hidden_size), dtype=np.int8)
    order = sorted(range(len(rows)), key=lambda i: len(rows[i][2]))
    print(f"Encoding {len(rows)} translations on {device}", flush=True)
    with torch.inference_mode():
        for start in range(0, len(order), 32):
            positions = order[start:start + 32]
            batch = tokenizer(
                ["passage: " + rows[i][2] for i in positions],
                padding=True, truncation=True, max_length=512, return_tensors="pt",
            ).to(device)
            hidden = encoder(**batch).last_hidden_state.float()
            mask = batch.attention_mask.unsqueeze(-1)
            pooled = (hidden * mask).sum(1) / mask.sum(1)
            scales = pooled.abs().amax(dim=1, keepdim=True) / 127
            vectors[positions] = (pooled / scales).round().clamp(-127, 127).cpu().numpy()

    path = Path("static/meaning")
    path.mkdir(parents=True, exist_ok=True)
    digest = corpus_hash(rows)
    filename = f"verses-{digest[:12]}-e5-v1.bin"
    (path / filename).write_bytes(vectors.tobytes())
    manifest = {
        "corpus": digest, "dimensions": vectors.shape[1], "file": filename,
        "refs": [f"{s}:{v}" for s, v, _ in rows],
    }
    (path / "index.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n",
                                   encoding="utf8")


if __name__ == "__main__":
    main()
