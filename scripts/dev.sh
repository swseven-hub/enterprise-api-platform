#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$ROOT_DIR/backend/.venv" ]; then
  python3 -m venv "$ROOT_DIR/backend/.venv"
fi

source "$ROOT_DIR/backend/.venv/bin/activate"
pip install -q -r "$ROOT_DIR/backend/requirements.txt"

if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  npm --prefix "$ROOT_DIR/frontend" install
fi

echo "Backend: http://127.0.0.1:8011"
echo "Frontend: http://127.0.0.1:5173"

trap 'kill 0' EXIT

(
  cd "$ROOT_DIR/backend"
  . .venv/bin/activate
  uvicorn app.main:app --host 127.0.0.1 --port 8011 --reload
) &

(
  cd "$ROOT_DIR/frontend"
  npm run dev -- --port 5173
) &

wait

