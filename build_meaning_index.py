"""Build deterministic all-fields browser assets with multilingual E5-small."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time

from build_search import load_rows
from meaning_search import all_fields_hash, field_hash

MODEL = "intfloat/multilingual-e5-small"
REVISION = "c007d7ef6fd86656326059b28395a7a03a7c5846"
RUNTIME_MODEL = "Xenova/multilingual-e5-small"
RUNTIME_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
DIMENSIONS = 384
MAX_TOKENS = 512
OVERLAP_TOKENS = 64
BATCH_SIZE = 32
TRANSLATION_CORPUS = "d1c40be0bef518288500f3940d4419b3516c2497b7285f5dcbd22802487e34e0"
TRANSLATION_VECTORS = "verses-d1c40be0bef5-e5-v1.bin"
TRANSLATION_VECTORS_SHA256 = "0cad61636eb49d656fb65e705da4b84f2038c2a771a10bc6bf3d57e16fc071e5"
FIELD_SPECS = (
	("ar_raw", "Arabic ayah text"),
	("en", "English translation"),
	("en_tafsir", "English tafsir"),
	("bn_tafsir", "Bengali tafsir"),
	("verse_context", "AI verse context"),
	("word_meanings", "AI word and root meanings"),
	("surah_name", "Surah names"),
)
FIELD_NAMES = tuple(name for name, _ in FIELD_SPECS)
SOURCE_FILES = (
	"db/quran.db",
	"db/en_quran.db",
	"db/en_kathir.db",
	"db/bn_zakaria.db",
	"db/ai_context.db",
	"db/quran_stat.json",
)


def sha256_bytes(payload: bytes) -> str:
	return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as handle:
		for block in iter(lambda: handle.read(1024 * 1024), b""):
			digest.update(block)
	return digest.hexdigest()


def atomic_write(path: Path, payload: bytes) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	temporary = path.with_name(path.name + ".tmp")
	temporary.write_bytes(payload)
	os.replace(temporary, path)


def tokenizer_options() -> dict:
	return {"revision": REVISION, "local_files_only": True}


def content_token_limit(tokenizer) -> int:
	prefix = tokenizer("passage: ", add_special_tokens=False, truncation=False)
	# E5 adds a CLS and a SEP token when the passage is encoded for the model.
	limit = MAX_TOKENS - len(prefix["input_ids"]) - 2
	if limit <= OVERLAP_TOKENS:
		raise ValueError("The E5 tokenizer leaves no room for overlapping passages")
	return limit


def chunk_text(tokenizer, text: str, limit: int | None = None) -> list[str]:
	"""Slice raw text on tokenizer offsets, preserving every token and its script."""
	if not text:
		return []
	limit = limit or content_token_limit(tokenizer)
	encoded = tokenizer(
		text,
		add_special_tokens=False,
		return_offsets_mapping=True,
		truncation=False,
	)
	offsets = [(start, end) for start, end in encoded["offset_mapping"] if end > start]
	if len(offsets) <= limit:
		return [text]
	chunks = []
	start = 0
	while start < len(offsets):
		end = min(start + limit, len(offsets))
		chunk = text[offsets[start][0]:offsets[end - 1][1]].strip()
		if not chunk:
			ids = encoded["input_ids"][start:end]
			chunk = tokenizer.decode(ids, skip_special_tokens=False).strip()
		if not chunk:
			raise ValueError("Token chunking produced an empty passage")
		chunks.append(chunk)
		if end == len(offsets):
			break
		start = end - OVERLAP_TOKENS
	return chunks


def make_passages(tokenizer, rows: list[dict], field: str):
	"""Return (ayah index, passage text, token length) in canonical field order."""
	limit = content_token_limit(tokenizer)
	passages = []
	for ayah_index, row in enumerate(rows):
		text = row[field]
		if not text:
			continue
		for chunk in chunk_text(tokenizer, text, limit):
			length = len(tokenizer(
				"passage: " + chunk,
				add_special_tokens=False,
				truncation=False,
			)["input_ids"])
			if length + 2 > MAX_TOKENS:
				raise ValueError(f"{field} passage exceeds {MAX_TOKENS} tokens")
			passages.append((ayah_index, chunk, length))
	return passages


def quantize(pooled):
	import numpy as np
	import torch

	scales = pooled.abs().amax(dim=1, keepdim=True) / 127
	scales = torch.where(scales > 0, scales, torch.ones_like(scales))
	vectors = (pooled / scales).round().clamp(-127, 127).to(torch.int8).cpu().numpy()
	if np.any(np.max(np.abs(vectors.astype(np.int16)), axis=1) == 0):
		raise ValueError("E5 produced a zero passage vector")
	return vectors


def encode_passages(tokenizer, encoder, passages, device: str, batch_size: int, threads: int):
	import numpy as np
	import torch

	vectors = np.empty((len(passages), DIMENSIONS), dtype=np.int8)
	order = sorted(range(len(passages)), key=lambda index: (passages[index][2], index))
	print(
		f"Encoding {len(passages)} passages on {device}, batch {batch_size}, "
		f"torch threads {threads}",
		flush=True,
	)
	started = time.time()
	with torch.inference_mode():
		for start in range(0, len(order), batch_size):
			positions = order[start:start + batch_size]
			batch = tokenizer(
				["passage: " + passages[index][1] for index in positions],
				padding=True,
				truncation=True,
				max_length=MAX_TOKENS,
				return_tensors="pt",
			).to(device)
			hidden = encoder(**batch).last_hidden_state.float()
			mask = batch.attention_mask.unsqueeze(-1)
			pooled = (hidden * mask).sum(1) / mask.sum(1)
			vectors[positions] = quantize(pooled)
			done = start + len(positions)
			if done % 512 < batch_size or done == len(passages):
				elapsed = time.time() - started
				rate = done / elapsed if elapsed else 0
				print(f"  {done}/{len(passages)} passages, {rate:.2f}/s", flush=True)
	return vectors


def reuse_translation_vectors(directory: Path, rows: list[dict], tokenizer):
	manifest_path = directory / "index.json"
	vectors_path = directory / TRANSLATION_VECTORS
	if not manifest_path.is_file() or not vectors_path.is_file():
		raise ValueError("The pinned translation-only baseline is required for vector reuse")
	manifest = json.loads(manifest_path.read_text(encoding="utf8"))
	refs = [f"{row['surah']}:{row['verse']}" for row in rows]
	if manifest.get("corpus") != TRANSLATION_CORPUS or field_hash(rows, "en") != TRANSLATION_CORPUS:
		raise ValueError("Translation corpus does not match the pinned PR #2 baseline")
	if manifest.get("refs") != refs or manifest.get("dimensions") != DIMENSIONS:
		raise ValueError("Translation references or dimensions differ from the pinned baseline")
	if manifest.get("file") != TRANSLATION_VECTORS or sha256_file(vectors_path) != TRANSLATION_VECTORS_SHA256:
		raise ValueError("Translation vectors do not match the pinned PR #2 baseline")
	if any(chunk_text(tokenizer, row["en"]) != [row["en"]] for row in rows):
		raise ValueError("A translation now needs chunking; rebuild the baseline deliberately")
	vectors_path = vectors_path.resolve()
	return vectors_path, list(range(len(rows)))


def validate_manifest(manifest: dict, rows: list[dict] | None, directory: Path) -> dict:
	"""Validate metadata and vector assets before a manifest is published."""
	import numpy as np

	if manifest.get("schema_version") != 2 or manifest.get("scope") != "all-fields":
		raise ValueError("Unsupported all-fields manifest")
	if manifest.get("dimensions") != DIMENSIONS:
		raise ValueError("Unexpected all-fields vector dimensions")
	if tuple(field["name"] for field in manifest["fields"]) != FIELD_NAMES:
		raise ValueError("All-fields manifest is missing a semantic field")
	if manifest.get("field_order") != list(FIELD_NAMES):
		raise ValueError("All-fields field order mismatch")
	refs = [f"{row['surah']}:{row['verse']}" for row in rows] if rows else manifest["refs"]
	canonical = sorted(set(refs), key=lambda ref: tuple(map(int, ref.split(":"))))
	if manifest["refs"] != refs or refs != canonical or len(refs) != 6236:
		raise ValueError("Expected 6,236 unique canonical ayah references")
	model = manifest.get("model", {})
	expected_model = {
		"name": MODEL,
		"revision": REVISION,
		"runtime_name": RUNTIME_MODEL,
		"runtime_revision": RUNTIME_REVISION,
		"passage_prefix": "passage: ",
		"query_prefix": "query: ",
		"pooling": "mean",
		"dtype": "int8",
		"quantization": "per_vector_absolute_max_127",
	}
	if model != expected_model:
		raise ValueError("All-fields model metadata mismatch")
	if manifest.get("builder_sha256") != sha256_file(Path(__file__).resolve()):
		raise ValueError("All-fields builder hash mismatch")
	chunking = manifest.get("chunking", {})
	if (
		chunking.get("max_tokens") != MAX_TOKENS
		or chunking.get("overlap_tokens") != OVERLAP_TOKENS
		or chunking.get("special_tokens") != 2
		or chunking.get("method") != "tokenizer_offsets_overlapping_windows"
		or chunking.get("ayah_aggregation") != "max_cosine"
		or not isinstance(chunking.get("content_tokens"), int)
		or not OVERLAP_TOKENS < chunking["content_tokens"] <= MAX_TOKENS - 2
	):
		raise ValueError("All-fields chunking configuration mismatch")
	fusion = manifest.get("fusion", {})
	weights = fusion.get("weights", {})
	values = list(weights.values()) if isinstance(weights, dict) else []
	if (
		fusion.get("status") not in ("pending_validation", "frozen")
		or fusion.get("candidates") != ["weighted_raw", "weighted_z"]
		or fusion.get("method") not in ("weighted_raw", "weighted_z")
		or set(weights) != set(FIELD_NAMES)
		or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in values)
		or not math.isclose(sum(values), 1.0, rel_tol=0.0, abs_tol=1e-9)
		or fusion.get("missing_fields") != "exclude_and_renormalize_per_ayah"
		or fusion.get("tie_break") != "canonical_ayah_order"
		or fusion.get("selection_metric_order") != ["useful_hit@5", "positive_hit@5", "ndcg@10"]
		or fusion.get("direct_hit_guardrail_pp") != 2.0
		or (fusion.get("status") == "frozen" and not isinstance(fusion.get("validation"), dict))
	):
		raise ValueError("Invalid all-fields fusion configuration")
	if fusion.get("status") == "frozen":
		validation = fusion["validation"]
		selected = validation.get("selected", {})
		if (
			selected.get("method") != fusion.get("method")
			or selected.get("weights") != weights
			or not validation.get("guardrail", {}).get("pass")
			or not validation.get("fixture_sha256")
			or not validation.get("diagnostics_sha256")
			or not validation.get("score_cache_fingerprint")
		):
			raise ValueError("Invalid frozen all-fields validation provenance")
	if set(manifest.get("sources", {})) != set(SOURCE_FILES):
		raise ValueError("All-fields source hash set mismatch")
	if rows:
		if all_fields_hash(rows) != manifest["corpus"]:
			raise ValueError("All-fields corpus hash mismatch")
		for relative, digest in manifest["sources"].items():
			if sha256_file(Path(__file__).resolve().parent / relative) != digest:
				raise ValueError(f"{relative} source hash mismatch")
		for field in manifest["fields"]:
			if field_hash(rows, field["name"]) != field["corpus_sha256"]:
				raise ValueError(f"{field['name']} corpus hash mismatch")
	files = set()
	for field, (name, label) in zip(manifest["fields"], FIELD_SPECS):
		if field["label"] != label or Path(field["file"]).name != field["file"]:
			raise ValueError(f"{name} field metadata mismatch")
		path = directory / field["file"]
		if sha256_file(path) != field["sha256"] or path.stat().st_size != field["bytes"]:
			raise ValueError(f"{name} vector asset hash mismatch")
		vectors = np.fromfile(path, dtype=np.int8)
		mapping = np.asarray(field["passage_to_ayah"], dtype=np.int32)
		if vectors.size != len(mapping) * DIMENSIONS or field["passages"] != len(mapping):
			raise ValueError(f"{name} vector/map length mismatch")
		if field["bytes"] != len(mapping) * DIMENSIONS:
			raise ValueError(f"{name} vector byte count mismatch")
		if mapping.size and (mapping.min() < 0 or mapping.max() >= len(refs)):
			raise ValueError(f"{name} passage map has an unknown ayah")
		if mapping.size > 1 and np.any(np.diff(mapping) < 0):
			raise ValueError(f"{name} passage map is not in canonical ayah order")
		norms = np.linalg.norm(vectors.reshape(-1, DIMENSIONS).astype(np.float32), axis=1)
		if np.any(norms == 0):
			raise ValueError(f"{name} contains a zero vector")
		present = set(mapping.tolist())
		expected = {index for index, ref in enumerate(refs) if rows and rows[index][name]}
		if rows and present != expected:
			raise ValueError(f"{name} missing-field coverage mismatch")
		if len(present) != field["present_ayat"] or field["missing_ayat"] != len(refs) - len(present):
			raise ValueError(f"{name} present/missing-ayah count mismatch")
		files.add(field["file"])
	assets = manifest.get("assets", {})
	if assets.get("unique_vector_files") != len(files):
		raise ValueError("All-fields unique vector-file count mismatch")
	if assets.get("vector_bytes") != sum((directory / name).stat().st_size for name in files):
		raise ValueError("All-fields aggregate vector byte count mismatch")
	return manifest


def validate_assets(manifest_path: Path, rows: list[dict] | None = None) -> dict:
	manifest = json.loads(manifest_path.read_text(encoding="utf8"))
	return validate_manifest(manifest, rows, manifest_path.parent)


def build(args: argparse.Namespace) -> None:
	import numpy as np
	import torch
	from transformers import AutoModel, AutoTokenizer

	started = time.time()
	root = Path(__file__).resolve().parent
	source_hashes = {relative: sha256_file(root / relative) for relative in SOURCE_FILES}
	rows = load_rows()
	refs = [f"{row['surah']}:{row['verse']}" for row in rows]
	if len(rows) != 6236 or refs != sorted(set(refs), key=lambda ref: tuple(map(int, ref.split(":")))):
		raise ValueError("Expected the complete canonical 6,236-ayah corpus")
	if any(not row[name] for row in rows for name in ("ar_raw", "en", "surah_name")):
		raise ValueError("Arabic, translation, and surah-name fields must be complete")

	torch.set_num_threads(args.threads)
	torch.set_num_interop_threads(1)
	torch.use_deterministic_algorithms(True)
	options = tokenizer_options()
	tokenizer = AutoTokenizer.from_pretrained(MODEL, **options)
	encoder = AutoModel.from_pretrained(MODEL, **options).eval()
	device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
	encoder = encoder.to(device)
	if encoder.config.hidden_size != DIMENSIONS:
		raise ValueError("Unexpected E5 hidden size")

	directory = Path(args.output).resolve().parent
	directory.mkdir(parents=True, exist_ok=True)
	fields = []
	for name, label in FIELD_SPECS:
		field_started = time.time()
		digest = field_hash(rows, name)
		print(f"Tokenizing {name}: {digest}", flush=True)
		if name == "en":
			vector_path, mapping = reuse_translation_vectors(directory, rows, tokenizer)
			passage_count = len(mapping)
			reused = True
		else:
			passages = make_passages(tokenizer, rows, name)
			vectors = encode_passages(
				tokenizer, encoder, passages, device, args.batch_size, args.threads
			)
			mapping = [passage[0] for passage in passages]
			filename = f"all-fields-{name}-{digest[:12]}-e5-v1.bin"
			vector_path = directory / filename
			payload = vectors.tobytes()
			if vector_path.is_file() and sha256_file(vector_path) == sha256_bytes(payload):
				pass
			else:
				atomic_write(vector_path, payload)
			passage_count = len(passages)
			reused = False
		present = len(set(mapping))
		field_entry = {
			"name": name,
			"label": label,
			"corpus_sha256": digest,
			"present_ayat": present,
			"missing_ayat": len(rows) - present,
			"passages": passage_count,
			"file": vector_path.name,
			"bytes": vector_path.stat().st_size,
			"sha256": sha256_file(vector_path),
			"passage_to_ayah": mapping,
			"reused_translation_baseline": reused,
		}
		fields.append(field_entry)
		print(
			f"  {name}: {passage_count} passages, {present} ayat, "
			f"{time.time() - field_started:.1f}s",
			flush=True,
		)

	unique_files = {field["file"] for field in fields}
	current_sources = {relative: sha256_file(root / relative) for relative in SOURCE_FILES}
	if current_sources != source_hashes:
		raise ValueError("Source files changed while the semantic index was being built")
	manifest = {
		"schema_version": 2,
		"scope": "all-fields",
		"corpus": all_fields_hash(rows),
		"dimensions": DIMENSIONS,
		"refs": refs,
		"model": {
			"name": MODEL,
			"revision": REVISION,
			"runtime_name": RUNTIME_MODEL,
			"runtime_revision": RUNTIME_REVISION,
			"passage_prefix": "passage: ",
			"query_prefix": "query: ",
			"pooling": "mean",
			"dtype": "int8",
			"quantization": "per_vector_absolute_max_127",
		},
		"chunking": {
			"max_tokens": MAX_TOKENS,
			"overlap_tokens": OVERLAP_TOKENS,
			"content_tokens": content_token_limit(tokenizer),
			"special_tokens": 2,
			"method": "tokenizer_offsets_overlapping_windows",
			"ayah_aggregation": "max_cosine",
		},
		"fields": fields,
		"field_order": list(FIELD_NAMES),
		"fusion": {
			"status": "pending_validation",
			"candidates": ["weighted_raw", "weighted_z"],
			"method": "weighted_z",
			"weights": dict(zip(FIELD_NAMES, (0.15, 0.20, 0.15, 0.10, 0.15, 0.15, 0.10))),
			"missing_fields": "exclude_and_renormalize_per_ayah",
			"tie_break": "canonical_ayah_order",
			"selection_metric_order": ["useful_hit@5", "positive_hit@5", "ndcg@10"],
			"direct_hit_guardrail_pp": 2.0,
		},
		"assets": {
			"unique_vector_files": len(unique_files),
			"vector_bytes": sum((directory / name).stat().st_size for name in unique_files),
		},
		"sources": source_hashes,
		"builder_sha256": sha256_file(Path(__file__).resolve()),
	}
	validate_manifest(manifest, rows, directory)
	payload = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf8")
	atomic_write(Path(args.output).resolve(), payload)
	validate_assets(Path(args.output).resolve(), rows)
	print(
		f"Wrote {args.output}: {manifest['assets']['vector_bytes'] / 1e6:.2f} MB "
		f"of vectors in {time.time() - started:.1f}s",
		flush=True,
	)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--output", default="static/meaning/all-fields-index.json")
	parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
	parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 1))
	parser.add_argument("--device", choices=("cpu", "cuda"))
	parser.add_argument("--validate-only", action="store_true")
	args = parser.parse_args()
	if args.batch_size < 1 or args.threads < 1:
		parser.error("--batch-size and --threads must be positive")
	if args.validate_only:
		rows = load_rows()
		manifest = validate_assets(Path(args.output).resolve(), rows)
		print(json.dumps({"valid": True, "assets": manifest["assets"]}, indent=2))
	else:
		build(args)


if __name__ == "__main__":
	main()
