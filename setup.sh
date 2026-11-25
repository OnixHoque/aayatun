#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
python3.12 deployment/manage.py install
.venv/bin/python deployment/manage.py build
printf '%s\n' 'Ready: .venv/bin/python deployment/manage.py serve --listen 127.0.0.1:8000'
