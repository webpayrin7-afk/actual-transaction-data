#!/usr/bin/env bash
# Detached PROFILE national background runner (AC-style long job).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/poc/profile-national"
mkdir -p "$OUT/cache"
cd "$ROOT"

if [[ -f "$OUT/runner.lock" ]]; then
  PID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$OUT/runner.lock','utf8')).pid||'')}catch(e){console.log('')}")"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "LOCK_HELD pid=$PID"
    exit 2
  fi
fi

# Build manifest first (foreground, fast)
npx tsx scripts/profile-national-background-runner.ts --init-manifest | tee "$OUT/init-manifest.out"

# Detach daemon
export PROFILE_NAT_BATCH="${PROFILE_NAT_BATCH:-25}"
export PROFILE_NAT_WAVE1_BATCH="${PROFILE_NAT_WAVE1_BATCH:-100}"
nohup npx tsx scripts/profile-national-background-runner.ts --run \
  >>"$OUT/runner.stdout.log" 2>>"$OUT/runner.stderr.log" &
echo $! >"$OUT/runner.pid"
disown || true

# Confirm first batch + heartbeat
npx tsx scripts/profile-national-background-runner.ts --verify-start
