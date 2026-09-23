#!/usr/bin/env bash
# Probe the official VWorld AL_D002 download every WATCH_INTERVAL seconds; once it
# serves a zip, run dry-run -> sanity gate -> commit (coords + living), then start
# the school nearby runner (LIVING_FOLLOW, DB missing-only). Safe to restart.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCHOOL_ROOT="${SCHOOL_ROOT:-/home/ubuntu/wt/school}"
INTERVAL="${WATCH_INTERVAL:-900}"
DIR="$ROOT/data/cache/vworld-join"
STATE="$DIR/watch-state.json"
mkdir -p "$DIR"
cd "$ROOT"
set -a; [[ -f .env.local ]] && . ./.env.local; set +a

state() { printf '{"at":"%s","status":"%s","detail":%s}\n' "$(date -u +%FT%TZ)" "$1" "${2:-null}" | tee "$STATE"; }

while true; do
  if [[ -f "$DIR/chain-done" ]]; then state CHAIN_DONE; exit 0; fi
  probe="$(python3 scripts/living/vworld-shp-join.py --probe 2>&1 | tail -1)"
  if [[ "$probe" != *'"ok": true'* ]]; then
    state WAIT_VWORLD "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$probe")"
    sleep "$INTERVAL"; continue
  fi
  state VWORLD_UP_DRY_RUN
  if ! python3 -u scripts/living/vworld-shp-join.py --dry-run; then
    state DRY_RUN_FAILED; sleep "$INTERVAL"; continue
  fi
  gate="$(python3 - <<'PY'
import json
p = json.load(open("data/cache/vworld-join/plan.json"))
c = p["classification"]; f = p["fills"]
ok = 0 < f <= c.get("HAS_PNU_NO_GEOMETRY", 0) <= 7680
print(("OK " if ok else "BAD ") + json.dumps({"fills": f, **c}))
PY
)"
  if [[ "$gate" != OK* ]]; then state GATE_FAILED "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$gate")"; sleep "$INTERVAL"; continue; fi
  state COMMIT "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$gate")"
  if python3 -u scripts/living/vworld-shp-join.py --commit; then
    (cd "$SCHOOL_ROOT" && set -a && { [[ -f .env.local ]] && . ./.env.local; true; } && set +a && bash scripts/school-national-background-start.sh)
    if python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); sys.exit(any("error" in s for s in p["sidos"].values()))' "$DIR/plan.json"; then
      touch "$DIR/chain-done"; state CHAIN_DONE; exit 0
    fi
    state PARTIAL_RETRY; sleep "$INTERVAL"; continue
  fi
  state COMMIT_FAILED; sleep "$INTERVAL"
done
