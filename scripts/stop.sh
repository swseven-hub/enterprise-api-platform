#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for file in "$ROOT_DIR"/logs/*.pid; do
  [ -f "$file" ] || continue
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
  fi
done

(lsof -ti tcp:5173 2>/dev/null; lsof -ti tcp:8011 2>/dev/null) | sort -u | xargs -r kill
