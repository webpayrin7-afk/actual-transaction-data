/**
 * 단지 비교 후보용 매매 면적·준공연도 집계 스냅샷(apt_trade_area_stats) 채움·갱신.
 * 법정동코드마다 거래 변경 번호(tx_change_marks)가 저장 번호와 다를 때만 다시 집계·게시한다.
 * 변경 표시 표가 없으면(scripts/apply-tx-change-marks.ts --apply 전) 에러로 멈춘다 — 아무것도 쓰지 않음.
 *
 *   npx tsx scripts/build-peer-area-stats.ts                   # 번호가 바뀐 코드만(처음엔 전체)
 *   npx tsx scripts/build-peer-area-stats.ts --lawd=11710,41117 # 지정 코드만
 *   npx tsx scripts/build-peer-area-stats.ts --full=1          # 번호와 상관없이 다시 집계(바뀐 행만 씀)
 *   --dry-run=1  쓰기 없이 몇 행이 바뀔지만 셈
 *   --pause-ms=1000  쓰기 묶음(200행) 사이 쉬는 시간
 *
 * 일일 동기화(scripts/sync-molit.ts)가 끝에서 같은 갱신을 부른다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { refreshPeerAreaStats } from "../src/lib/complex-detail/peer-area-stats-refresh";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const db = getDb();
  if (!db) {
    console.error("DB unavailable");
    process.exit(1);
  }
  const lawd = argValue("lawd", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const result = await refreshPeerAreaStats(db, {
    full: argValue("full", "0") === "1",
    dryRun: argValue("dry-run", "0") === "1",
    lawdCodes: lawd.length > 0 ? lawd : undefined,
    pauseMs: Number(argValue("pause-ms", "1000")),
    log: (m) => console.log(m),
  });
  console.log(`[peer-area] SUMMARY ${JSON.stringify(result)}`);
  if (result.failures.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
