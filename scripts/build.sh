#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$ROOT_DIR/backend/.venv" ]; then
  python3 -m venv "$ROOT_DIR/backend/.venv"
fi

source "$ROOT_DIR/backend/.venv/bin/activate"
pip install -q -r "$ROOT_DIR/backend/requirements.txt"
python -m py_compile "$ROOT_DIR"/backend/app/*.py

npm --prefix "$ROOT_DIR/frontend" install
npm --prefix "$ROOT_DIR/frontend" run build

