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

DEPLOYMENT = Path(__file__).resolve().parent
FEATURE = DEPLOYMENT.parent
ROOT = FEATURE.parents[1]
KIT = Path(os.environ.get('AAYATUN_MEANING_KIT', DEPLOYMENT / 'kit')).resolve()
DIST = FEATURE / 'dist'
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ['HF_HUB_CACHE'] = str(KIT / 'models/hub')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def verify(optional=False):
    manifest = 'optional-assets.json' if optional else 'assets.json'
    entries = json.loads((DEPLOYMENT / manifest).read_text(encoding='utf8'))['files']
    for relative, expected in entries.items():
        path = (KIT if optional else ROOT) / relative
        if not path.is_file():
            raise SystemExit(f'Missing asset: {relative}. See features/meaning_search/deployment/README.md for the runtime files or optional build kit.')
        hasher = hashlib.sha256()
        if expected.get('line_endings') == 'lf':
            payload = path.read_bytes().replace(b'\r\n', b'\n')
            size = len(payload)
            hasher.update(payload)
        else:
            size = path.stat().st_size
            with path.open('rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    hasher.update(chunk)
        if size != expected['bytes'] or hasher.hexdigest() != expected['sha256']:
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
    from features.meaning_search import build_meaning_index as builder
    tokenizer = AutoTokenizer.from_pretrained(builder.MODEL, **builder.tokenizer_options())
    encoder = AutoModel.from_pretrained(builder.MODEL, **builder.tokenizer_options()).eval()
    passages = builder.make_passages(tokenizer, [{'verse_context': 'Accountability on the Day of Judgement.'}], 'verse_context')
    vectors = builder.encode_passages(tokenizer, encoder, passages, 'cpu', 1, 4)
    assert vectors.shape == (1, 384) and vectors.any()
    print('Offline builder smoke: local tokenizer + checkpoint + passage encoder, 384 dimensions.')


def install(offline=False, build_deps=False):
    venv.EnvBuilder(with_pip=True).create(FEATURE / '.venv')
    executable = FEATURE / ('.venv/Scripts/python.exe' if sys.platform == 'win32' else '.venv/bin/python')
    command = [str(executable), '-m', 'pip', 'install']
    if offline:
        verify(optional=True)
        if sys.version_info[:2] != (3, 12) or platform.machine().lower() not in ('amd64', 'x86_64'):
            raise SystemExit('Optional offline wheels require CPython 3.12 x64.')
        target = 'windows-cp312' if sys.platform == 'win32' else 'linux-cp312' if sys.platform == 'linux' else None
        if target is None:
            raise SystemExit('No optional offline wheels for this OS.')
        lock = DEPLOYMENT / f'{target}{"" if build_deps else "-runtime"}.lock'
        command += ['--no-index', '--no-cache-dir', '--find-links', str(KIT / 'deployment/wheels' / target),
                    '--require-hashes', '-r', str(lock)]
    else:
        command += ['-r', str(FEATURE / ('requirements-build.txt' if build_deps else 'requirements-runtime.txt'))]
        if build_deps:
            command += ['--extra-index-url', 'https://download.pytorch.org/whl/cpu']
    subprocess.run(command, check=True)
    print(f'Installed {"build" if build_deps else "runtime"} dependencies. Python: {executable}')


def package(optional=False):
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = [name for name in files if name]
    if optional:
        files = list(json.loads((DEPLOYMENT / 'optional-assets.json').read_text())["files"])
    for name in ('db/search.db', 'db/search_vocab.pkl'):
        if not optional and (ROOT / name).is_file():
            files.append(name)
    output = DIST / ('aayatun-optional-offline-build.zip' if optional else 'aayatun-runtime.zip')
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for name in sorted(set(files)):
            archive.write((KIT if optional else ROOT) / name, name if optional else 'aayatun/' + name)
        if optional:
            for lock in DEPLOYMENT.glob('*.lock'):
                archive.write(lock, 'deployment/' + lock.name)
            archive.write(DEPLOYMENT / 'optional-assets.json', 'deployment/optional-assets.json')
    print(f'Packaged actual LFS contents and application files: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'install', 'build', 'smoke-model', 'rebuild-embeddings', 'serve', 'package'])
    parser.add_argument('--runtime-only', action='store_true', help='Compatibility alias; runtime is already the default')
    parser.add_argument('--offline', action='store_true', help='Install from the separately downloaded optional kit')
    parser.add_argument('--build-deps', action='store_true', help='Install optional embedding-builder dependencies')
    parser.add_argument('--optional', action='store_true', help='Verify/package the optional offline build kit')
    parser.add_argument('--listen', default='127.0.0.1:8000')
    args = parser.parse_args()
    verify()
    if args.optional or args.command in ("smoke-model", "rebuild-embeddings"):
        verify(optional=True)
    if args.command == 'install':
        install(args.offline, args.build_deps)
    elif args.command == 'build':
        run('build_search.py')
        run('-m', 'features.meaning_search.build_meaning_index', '--validate-only')
    elif args.command == 'smoke-model':
        smoke_model()
    elif args.command == 'rebuild-embeddings':
        run('build_search.py')
        # Keep the validated deployed manifest; a new build needs fresh validation.
        output = DIST / 'rebuilt'
        output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(FEATURE / 'static/verses-d1c40be0bef5-e5-v1.bin',
                        output / 'verses-d1c40be0bef5-e5-v1.bin')
        run('-m', 'features.meaning_search.build_meaning_index', '--output', str(output / 'all-fields-index.json'), '--device', 'cpu')
    elif args.command == 'serve':
        from waitress import serve
        from app import app
        host, port = args.listen.rsplit(':', 1)
        serve(app, host=host, port=int(port))
    elif args.command == 'package':
        package(args.optional)


if __name__ == '__main__':
    main()
