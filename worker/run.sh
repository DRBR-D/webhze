#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Chưa có máy ảo Python .venv! Tạo mới..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install --no-cache-dir -r requirements.txt
fi

exec .venv/bin/python translate_worker.py "$@"
