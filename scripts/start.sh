#!/usr/bin/env bash
# Bedrock Portal - macOS/Linux launcher.  Usage: ./scripts/start.sh [--port 8787] [--host 127.0.0.1] [--rebuild]
set -euo pipefail
PORT=8787; HOST=127.0.0.1; REBUILD=0
while [[ $# -gt 0 ]]; do case "$1" in
  --port) PORT="$2"; shift 2;; --host) HOST="$2"; shift 2;; --rebuild) REBUILD=1; shift;;
  *) echo "unknown option $1"; exit 1;; esac; done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/.env" ]] && set -a && . "$ROOT/.env" && set +a
cd "$ROOT/backend"
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if [[ $REBUILD == 1 || ! -f "$ROOT/frontend/dist/index.html" ]]; then
  if command -v npm >/dev/null; then (cd "$ROOT/frontend" && { [[ -f package-lock.json ]] && npm ci || npm install; } && npm run build)
  else echo "npm not found: dashboard not built (API still works). Install Node 20+."; fi
fi
echo; echo "Bedrock Portal -> http://$HOST:$PORT   (OpenAI base URL: http://$HOST:$PORT/v1)"; echo
exec .venv/bin/python -m uvicorn app.main:app --host "$HOST" --port "$PORT"
