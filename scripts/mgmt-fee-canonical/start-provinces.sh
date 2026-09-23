#!/usr/bin/env bash
# Unattended province closeout driver: freeze -> acquire (segmented, checkpointed) -> dry-run -> apply -> verify.
# Resumable: re-running skips provinces whose apply-result is PASS and resumes the current checkpoint.
#
#   bash scripts/mgmt-fee-canonical/start-provinces.sh            # start in tmux session fee-provinces
#   bash scripts/mgmt-fee-canonical/start-provinces.sh --foreground
#   PROVINCES="incheon busan" bash scripts/mgmt-fee-canonical/start-provinces.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION=fee-provinces
TMUX_CONF=/exec-daemon/tmux.portal.conf
tmuxc() { if [ -f "$TMUX_CONF" ]; then tmux -f "$TMUX_CONF" "$@"; else tmux "$@"; fi; }

if [ "${1:-}" != "--foreground" ]; then
  if tmuxc has-session -t "=$SESSION" 2>/dev/null; then
    echo "session $SESSION already running; attach with: tmux attach -t $SESSION"
    exit 0
  fi
  tmuxc new-session -d -s "$SESSION" -c "$ROOT" -- bash -lc "PROVINCES='${PROVINCES:-}' bash '$ROOT/scripts/mgmt-fee-canonical/start-provinces.sh' --foreground 2>&1 | tee -a '$ROOT/data/poc/mgmt-fee-canonical/provinces-driver.log'"
  echo "started tmux session $SESSION"
  exit 0
fi

cd "$ROOT"
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
DIR=data/poc/mgmt-fee-canonical
ORDER="${PROVINCES:-incheon busan daegu gwangju-jeonnam daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk gyeongbuk gyeongnam jeju}"
MAX_ERROR_RETRIES=3
MAX_QUOTA_HOLDS=7
TSX="npx tsx"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

progress() { $TSX scripts/mgmt-fee-canonical/report-province-progress.mts "--driver-status=$1" || true; }

commit_push() {
  git add "$DIR"/province-*-final-* "$DIR/provinces-progress.json" 2>/dev/null || true
  if git diff --cached --quiet; then return 0; fi
  git commit -q -m "mgmt-fee provinces: $1" || return 0
  local delay=4
  for _ in 1 2 3 4 5; do
    if git push -q -u origin "$BRANCH"; then return 0; fi
    sleep "$delay"; delay=$((delay * 2))
  done
  log "push failed (will retry on next commit)"
}

seconds_until_quota_reset() {
  # data.go.kr daily quota resets at 00:00 KST; resume at 00:10 KST.
  local now target
  now=$(date -u +%s)
  target=$(TZ=Asia/Seoul date -d "tomorrow 00:10" +%s)
  echo $((target - now))
}

run_province() {
  local p=$1 prefix="$DIR/province-$1-final"
  if [ -f "$prefix-apply-result.json" ] && grep -q '"status": "PASS"' "$prefix-apply-result.json"; then
    log "$p already applied; skip"
    return 0
  fi
  local errors=0 holds=0 out rc
  while true; do
    log "$p acquire run"
    out=$(mktemp)
    $TSX scripts/mgmt-fee-canonical/run-province-final.mts "--province=$p" 2>&1 | tee "$out"
    rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 0 ] && grep -q PROVINCE_COHORT_TERMINAL "$out"; then
      rm -f "$out"; break
    elif [ "$rc" -eq 0 ] && grep -q PROVINCE_SEGMENT_PAUSE "$out"; then
      errors=0; holds=0
      progress "$p acquiring"; commit_push "$p acquire checkpoint"
    elif [ "$rc" -eq 2 ]; then
      holds=$((holds + 1))
      progress "$p quota hold $holds"; commit_push "$p quota hold checkpoint"
      if [ "$holds" -gt "$MAX_QUOTA_HOLDS" ]; then
        log "$p quota hold exceeded $MAX_QUOTA_HOLDS consecutive days; stopping"; rm -f "$out"; return 2
      fi
      local wait; wait=$(seconds_until_quota_reset)
      log "$p quota/429 hold; sleeping ${wait}s until 00:10 KST"
      sleep "$wait"
    else
      errors=$((errors + 1))
      if [ "$errors" -gt "$MAX_ERROR_RETRIES" ]; then
        log "$p acquire failed $errors times (rc=$rc); stopping"; rm -f "$out"; return 1
      fi
      log "$p acquire error rc=$rc; retry $errors in $((errors * 300))s"
      sleep $((errors * 300))
    fi
    rm -f "$out"
  done

  if ! grep -q '"gate": "PASS"' "$prefix-dryrun.json"; then
    log "$p dry-run gate not PASS; stopping"; progress "$p dry-run blocked"; commit_push "$p dry-run blocked"; return 3
  fi
  progress "$p dry-run PASS"; commit_push "$p dry-run PASS"

  log "$p apply precheck"
  $TSX scripts/mgmt-fee-canonical/apply-province-final.mts "--province=$p" || { log "$p precheck blocked"; progress "$p apply blocked"; commit_push "$p apply blocked"; return 4; }
  log "$p apply --commit"
  $TSX scripts/mgmt-fee-canonical/apply-province-final.mts "--province=$p" --commit || { log "$p apply failed"; progress "$p apply failed"; commit_push "$p apply failed"; return 5; }
  log "$p verify (second apply must be a no-op)"
  if ! $TSX scripts/mgmt-fee-canonical/apply-province-final.mts "--province=$p" --commit | tee /dev/stderr | grep -qE 'IDEMPOTENT_NOOP|PRECHECK_OK'; then
    log "$p idempotency verify failed; stopping"; progress "$p verify failed"; commit_push "$p verify failed"; return 6
  fi
  progress "$p applied"; commit_push "$p applied"
  return 0
}

log "driver start order: $ORDER"
for p in $ORDER; do
  if ! run_province "$p"; then
    progress "stopped at $p"; commit_push "driver stopped at $p"
    log "driver stopped at $p; fix and re-run start-provinces.sh to resume"
    exit 1
  fi
done
progress "all provinces done"; commit_push "all provinces done"
log "driver done"
