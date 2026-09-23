#!/usr/bin/env bash
# Detached national coordinate + living missing-only runner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="$ROOT/data/cache/living-runner"
mkdir -p "$RUN_DIR"
cd "$ROOT"

if [[ -f "$RUN_DIR/runner.lock" ]]; then
  if python3 - <<'PY'
import fcntl, sys
from pathlib import Path
p = Path("data/cache/living-runner/runner.lock")
try:
    h = p.open("a+")
    fcntl.flock(h.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(h.fileno(), fcntl.LOCK_UN)
    h.close()
    sys.exit(0)
except BlockingIOError:
    sys.exit(1)
PY
  then
    : # lock free
  else
    echo "runner already locked" >&2
    cat "$RUN_DIR/runner.lock" >&2 || true
    exit 2
  fi
fi

nohup python3 -u scripts/living/run-national-coordinate-backfill.py --daemon --max-cycles=12 \
  >"$RUN_DIR/nohup.out" 2>&1 &
echo $! >"$RUN_DIR/runner.pid"
echo "started pid=$(cat "$RUN_DIR/runner.pid")"
