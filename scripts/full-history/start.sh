#!/usr/bin/env bash
# Detached TRUE NATIONAL full-history SALE+RENT runner (AC-style).
# Survives agent exit via tmux.
#
#   bash scripts/full-history/start.sh
#   bash scripts/full-history/start.sh --verify-only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/data/poc/full-history"
SESSION="molit-full-history"
TMUX_CONF="/exec-daemon/tmux.portal.conf"
cd "$ROOT"
mkdir -p "$OUT"

VERIFY_ONLY=0
if [[ "${1:-}" == "--verify-only" ]]; then
  VERIFY_ONLY=1
fi

if [[ "$VERIFY_ONLY" -eq 0 ]]; then
  # Refuse if live lock
  if [[ -f "$OUT/run.lock" ]]; then
    PID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$OUT/run.lock','utf8')).pid||'')}catch{console.log('')}")"
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      echo "LOCK_HELD pid=$PID"
      npx tsx scripts/full-history/runner.mts --verify-start=1
      exit 2
    fi
  fi

  # Ensure manifests
  if [[ ! -f "$OUT/manifest-summary.json" ]]; then
    echo "[start] building manifests..."
    npx tsx scripts/full-history/build-manifests.mts | tee "$OUT/manifest-build.log"
  fi

  TMUX=(tmux)
  if [[ -f "$TMUX_CONF" ]]; then
    TMUX=(tmux -f "$TMUX_CONF")
  fi

  "${TMUX[@]}" has-session -t "=$SESSION" 2>/dev/null || \
    "${TMUX[@]}" new-session -d -s "$SESSION" -c "$ROOT" -- "${SHELL:-bash}" -l

  # Clear any leftover prompt noise, then launch daemon
  "${TMUX[@]}" send-keys -t "$SESSION:0.0" C-c 2>/dev/null || true
  sleep 0.2
  CMD="cd '$ROOT' && npx tsx scripts/full-history/runner.mts --daemon --apply=1 --concurrency=2 --sleep-ms=250 --first-batch=8 >> '$OUT/runner.log' 2>&1; echo EXIT:\$? >> '$OUT/runner.log'"
  "${TMUX[@]}" send-keys -t "$SESSION:0.0" "$CMD" C-m
  echo "[start] launched session=$SESSION"
fi

# Wait for BACKGROUND_RUNNING gate (first batch applied + heartbeat)
echo "[start] waiting for first batch / start gate..."
OK=0
for i in $(seq 1 90); do
  if npx tsx scripts/full-history/runner.mts --verify-start=1 >/tmp/fh-verify.json 2>/tmp/fh-verify.err; then
    OK=1
    break
  fi
  sleep 2
done

if [[ "$OK" -eq 1 ]]; then
  echo "[start] BACKGROUND_RUNNING"
  cat /tmp/fh-verify.json
  exit 0
fi

echo "[start] FAILED_TO_START"
cat /tmp/fh-verify.err || true
cat /tmp/fh-verify.json || true
tail -n 40 "$OUT/runner.log" || true
exit 3
