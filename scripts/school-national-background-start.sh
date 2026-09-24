#!/usr/bin/env bash
# Detach national SCHOOL nearby background runner (AC-style resume + process lock).
# Continues after the launching shell/agent exits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DIR="$ROOT/data/poc/school-national/runner"
mkdir -p "$DIR"
LOCK="$DIR/runner.lock.json"
OUT="$DIR/runner.stdout.log"
ERR="$DIR/runner.stderr.log"

if [[ -f "$LOCK" ]]; then
  PID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' "$LOCK" 2>/dev/null || true)"
  if [[ -n "${PID}" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "ALREADY_RUNNING pid=$PID"
    exit 0
  fi
  echo "clearing stale lock pid=${PID:-unknown}"
  rm -f "$LOCK"
fi

# Export secrets into detached environment
export TURSO_DATABASE_URL="${TURSO_DATABASE_URL:-}"
export TURSO_AUTH_TOKEN="${TURSO_AUTH_TOKEN:-}"
# Unlimited LIVING follow by default; override for tests
export SCHOOL_RUNNER_MAX_IDLE_CYCLES="${SCHOOL_RUNNER_MAX_IDLE_CYCLES:-0}"

# Short first idle for start-gate verification can be set by caller via env;
# production default keeps 15-minute dependency poll inside the runner.

nohup npx tsx scripts/school-national-background-runner.ts --write \
  >>"$OUT" 2>>"$ERR" &
BGPID=$!
disown "$BGPID" 2>/dev/null || true

# Wait briefly for lock + first checkpoint
for i in $(seq 1 60); do
  if [[ -f "$LOCK" && -f "$DIR/progress.json" && -f "$DIR/checkpoint.json" ]]; then
    break
  fi
  sleep 1
done

if ! kill -0 "$BGPID" 2>/dev/null; then
  echo "FAILED_TO_START"
  tail -n 80 "$ERR" || true
  exit 1
fi

echo "STARTED pid=$BGPID"
echo "lock=$LOCK"
echo "progress=$DIR/progress.json"
echo "log=$DIR/runner.log.jsonl"
echo "stdout=$OUT"
