"""Maintainer-only: record wheel locks and checked-in deployment asset hashes."""
import email
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
runtime = {'flask', 'werkzeug', 'jinja2', 'markupsafe', 'blinker', 'click', 'itsdangerous',
           'numpy', 'pandas', 'python-dateutil', 'pytz', 'six', 'tzdata', 'waitress', 'colorama'}


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


for directory in sorted((ROOT / 'deployment/wheels').glob('*')):
    full, minimal = [], []
    for wheel in sorted(directory.glob('*.whl')):
        with zipfile.ZipFile(wheel) as archive:
            name = next(name for name in archive.namelist() if name.endswith('.dist-info/METADATA'))
            metadata = email.message_from_bytes(archive.read(name))
        line = f"{metadata['Name']}=={metadata['Version']} --hash=sha256:{digest(wheel)}\n"
        full.append(line)
        if metadata['Name'].lower().replace('_', '-') in runtime:
            minimal.append(line)
    for suffix, lines in [('', full), ('-runtime', minimal)]:
        (ROOT / 'deployment' / f'{directory.name}{suffix}.lock').write_text(
            '# Exact bundled wheels; install using --no-index --require-hashes.\n' + ''.join(lines), encoding='utf8')

files = []
for pattern in ('static/meaning/**/*', 'static/vendor/**/*', 'deployment/licenses/*'):
    files.extend(path for path in ROOT.glob(pattern) if path.is_file())
tracked_data = subprocess.check_output(['git', 'ls-files', '-z', 'db', 'db2'], cwd=ROOT).decode().split('\0')
files.extend(ROOT / name for name in tracked_data if name)
entries = {path.relative_to(ROOT).as_posix(): {'bytes': path.stat().st_size, 'sha256': digest(path)}
           for path in sorted(set(files))}
(ROOT / 'deployment/assets.json').write_text(json.dumps({
    'schema_version': 1,
    'runtime': 'Transformers.js 3.7.2 / ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4',
    'runtime_model': 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    'builder_model': 'intfloat/multilingual-e5-small@c007d7ef6fd86656326059b28395a7a03a7c5846',
    'files': entries,
}, indent=2) + '\n', encoding='utf8')
print(f'Locked {len(entries)} required runtime/data assets. Optional build assets are tracked separately.')
