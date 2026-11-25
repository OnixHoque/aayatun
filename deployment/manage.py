"""Offline installation, asset verification, index builds and packaging (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import venv
import zipfile

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ['HF_HUB_CACHE'] = str(ROOT / 'models/hub')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def verify():
    entries = json.loads((ROOT / 'deployment/assets.json').read_text(encoding='utf8'))['files']
    for relative, expected in entries.items():
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit(f'Missing asset: {relative}. Run git lfs pull before disconnecting.')
        with path.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if path.stat().st_size != expected['bytes'] or digest != expected['sha256']:
            raise SystemExit(f'Incomplete or modified asset: {relative}. Check Git LFS downloads.')
    print(f'Verified {len(entries)} assets; no downloads.', flush=True)


def run(*args):
    subprocess.run([sys.executable, *args], check=True, cwd=ROOT)


def smoke_model():
    # Deny sockets even if a library accidentally ignores offline configuration.
    def deny_network(*args, **kwargs):
        raise RuntimeError('Network is disabled during the offline model smoke test')
    socket.socket.connect = deny_network
    import torch
    from transformers import AutoModel, AutoTokenizer
    torch.set_num_threads(4)
    import build_meaning_index as builder
    tokenizer = AutoTokenizer.from_pretrained(builder.MODEL, **builder.tokenizer_options())
    encoder = AutoModel.from_pretrained(builder.MODEL, **builder.tokenizer_options()).eval()
    passages = builder.make_passages(tokenizer, [{'verse_context': 'Accountability on the Day of Judgement.'}], 'verse_context')
    vectors = builder.encode_passages(tokenizer, encoder, passages, 'cpu', 1, 4)
    assert vectors.shape == (1, 384) and vectors.any()
    print('Offline builder smoke: local tokenizer + checkpoint + passage encoder, 384 dimensions.')


def install(runtime_only):
    if sys.version_info[:2] != (3, 12) or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise SystemExit('Bundled wheels require CPython 3.12 x64 (Windows or glibc Linux >= 2.28).')
    target = 'windows-cp312' if sys.platform == 'win32' else 'linux-cp312' if sys.platform == 'linux' else None
    if target is None:
        raise SystemExit('No bundled wheels for this operating system.')
    venv.EnvBuilder(with_pip=True).create(ROOT / '.venv')
    executable = ROOT / ('.venv/Scripts/python.exe' if sys.platform == 'win32' else '.venv/bin/python')
    lock = ROOT / 'deployment' / f'{target}{"-runtime" if runtime_only else ""}.lock'
    subprocess.run([str(executable), '-m', 'pip', 'install', '--no-index', '--no-cache-dir',
                    '--find-links', str(ROOT / 'deployment/wheels' / target), '--require-hashes',
                    '-r', str(lock)], check=True)
    print(f'Installed entirely from bundled wheels. Python: {executable}')


def package():
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = [name for name in files if name]
    for name in ('db/search.db', 'db/search_vocab.pkl'):
        if (ROOT / name).is_file():
            files.append(name)
    output = ROOT / 'dist/aayatun-offline.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name in sorted(set(files)):
            archive.write(ROOT / name, 'aayatun/' + name)
    print(f'Packaged actual LFS contents and application files: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'install', 'build', 'smoke-model', 'rebuild-embeddings', 'serve', 'package'])
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--listen', default='127.0.0.1:8000')
    args = parser.parse_args()
    verify()
    if args.command == 'install':
        install(args.runtime_only)
    elif args.command == 'build':
        run('build_search.py')
        run('build_meaning_index.py', '--validate-only')
    elif args.command == 'smoke-model':
        smoke_model()
    elif args.command == 'rebuild-embeddings':
        run('build_search.py')
        # Keep the validated deployed manifest; a new build needs fresh validation.
        output = ROOT / 'dist/rebuilt'
        output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'static/meaning/verses-d1c40be0bef5-e5-v1.bin',
                        output / 'verses-d1c40be0bef5-e5-v1.bin')
        run('build_meaning_index.py', '--output', 'dist/rebuilt/all-fields-index.json', '--device', 'cpu')
    elif args.command == 'serve':
        from waitress import serve
        from app import app
        host, port = args.listen.rsplit(':', 1)
        serve(app, host=host, port=int(port))
    elif args.command == 'package':
        package()


if __name__ == '__main__':
    main()
