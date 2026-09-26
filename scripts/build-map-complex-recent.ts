/**
 * 지도 단지 최근 거래 스냅샷(map_complex_recent) 만들기·갱신.
 * 신선도는 transactions 변경 표시(tx_change_marks) — 먼저 scripts/apply-tx-change-marks.ts --apply 가 돼 있어야 한다.
 *
 *   npx tsx scripts/build-map-complex-recent.ts                 # dry-run: 다시 읽을 단지·바뀔 행 수만 (쓰기 없음)
 *   npx tsx scripts/build-map-complex-recent.ts --apply=1       # 변경 번호가 바뀐 시군구의 바뀐 단지만 다시 만든다
 *   npx tsx scripts/build-map-complex-recent.ts --apply=1 --mode=all        # 모든 시군구 확인 (번호가 같은 단지는 읽지 않음)
 *   npx tsx scripts/build-map-complex-recent.ts --apply=1 --lawds=11710,11680
 *
 * 매일 동기화(scripts/sync-molit.ts)가 거래를 쓴 뒤 mode=stale 로 같은 갱신을 부른다.
 * 쓰기: 내용이 같으면 번호만(UPDATE), 다르면 행 upsert — 둘 다 번호가 아직 같을 때만. 200개마다 1초 쉬고, 한 문장이 5초를 넘으면 멈춘다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { refreshMapComplexRecent } from "../src/lib/map/map-complex-recent";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL 이 없습니다.");
  const apply = argValue("apply", "0") === "1";
  const mode = argValue("mode", "stale") === "all" ? "all" : "stale";
  const lawdsArg = argValue("lawds", "");
  const lawds = lawdsArg ? lawdsArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const concurrency = Number(argValue("concurrency", "2")) || 2;
  const started = Date.now();
  const total = await refreshMapComplexRecent(db, {
    mode,
    lawds,
    dryRun: !apply,
    concurrency,
    log: (s) => console.log(s),
  });
  console.log(
    `[map-recent] SUMMARY ${apply ? "APPLY" : "DRY-RUN"} mode=${lawds ? "lawds" : mode} lawds=${total.lawds} targets=${total.targets} written=${total.written} markOnly=${total.markOnly} skippedChanged=${total.skippedChanged} deleted=${total.deleted} unchanged=${total.unchanged} mb=${(total.bytes / 1048576).toFixed(1)} sec=${Math.round((Date.now() - started) / 1000)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
