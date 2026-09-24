#!/usr/bin/env bash
# External watchdog: if progress.json is stale while lock PID is live, kill+resume.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/poc/profile-national"
STALE_SEC="${PROFILE_WATCHDOG_STALE_SEC:-180}"
SLEEP_SEC="${PROFILE_WATCHDOG_SLEEP_SEC:-60}"
cd "$ROOT"
mkdir -p "$OUT"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog start stale=${STALE_SEC}s" >>"$OUT/watchdog.log"

while true; do
  sleep "$SLEEP_SEC"
  LOCK="$OUT/runner.lock"
  PROG="$OUT/progress.json"
  if [[ ! -f "$LOCK" || ! -f "$PROG" ]]; then
    continue
  fi
  PID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$LOCK','utf8')).pid||'')}catch(e){console.log('')}")"
  if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
    # runner dead — if not DONE, resume
    TERM="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PROG','utf8')).terminal||'')}catch(e){console.log('')}")"
    WAVE="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PROG','utf8')).wave||'')}catch(e){console.log('')}")"
    if [[ "$WAVE" == "DONE" || "$TERM" == "COMPLETE" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog exit DONE" >>"$OUT/watchdog.log"
      exit 0
    fi
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog resume dead_runner" >>"$OUT/watchdog.log"
    rm -f "$LOCK"
    nohup npx tsx scripts/profile-national-background-runner.ts --run >>"$OUT/runner.stdout.log" 2>>"$OUT/runner.stderr.log" &
    echo $! >"$OUT/runner.pid"
    disown || true
    continue
  fi
  AGE="$(node -e "
    const p=JSON.parse(require('fs').readFileSync('$PROG','utf8'));
    const t=Date.parse(p.updated_at||0);
    console.log(Number.isFinite(t)?Math.floor((Date.now()-t)/1000):99999);
  ")"
  if [[ "$AGE" -ge "$STALE_SEC" ]]; then
    CID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PROG','utf8')).current_complex_id||'')}catch(e){console.log('')}")"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog kill stale=${AGE}s pid=$PID cid=$CID" >>"$OUT/watchdog.log"
    # mark current complex done so we skip the wedged target
    node -e "
      const fs=require('fs');
      const cid='$CID';
      if(!cid) process.exit(0);
      const ck=JSON.parse(fs.readFileSync('$OUT/checkpoint.json','utf8'));
      const key='w2:'+cid;
      if(!ck.done_ids.includes(key)) ck.done_ids.push(key);
      ck.updated_at=new Date().toISOString();
      fs.writeFileSync('$OUT/checkpoint.json', JSON.stringify(ck,null,2));
      fs.appendFileSync('$OUT/retry-queue.jsonl', JSON.stringify({complex_id:cid,wave:'WAVE2',error:'watchdog_stale_skip',at:new Date().toISOString()})+'\n');
    "
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
    pkill -f 'profile-national-background-runner.ts --run' 2>/dev/null || true
    sleep 2
    rm -f "$LOCK"
    nohup npx tsx scripts/profile-national-background-runner.ts --run >>"$OUT/runner.stdout.log" 2>>"$OUT/runner.stderr.log" &
    echo $! >"$OUT/runner.pid"
    disown || true
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog restarted" >>"$OUT/watchdog.log"
  fi
done
