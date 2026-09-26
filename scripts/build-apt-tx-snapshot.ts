/**
 * 단지 실거래 스냅샷(apt_tx_hist_snap) 초기 적재 / 재빌드 / 갱신.
 *
 *   # 드라이런(기본, 쓰기 0): 몇 단지·몇 MB 가 들어갈지
 *   npx tsx scripts/build-apt-tx-snapshot.ts --lawd=11710
 *   npx tsx scripts/build-apt-tx-snapshot.ts --all
 *
 *   # 적용 (표 CREATE IF NOT EXISTS + 최신이 아닌 단지만 조건부 UPSERT)
 *   npx tsx scripts/build-apt-tx-snapshot.ts --all --apply
 *
 *   # 갱신만 (일일 sync 끝에서 도는 것과 같음: 기준 번호 뒤에 바뀐 단지만)
 *   npx tsx scripts/build-apt-tx-snapshot.ts --refresh --apply
 *
 * 전제: transactions 변경 표시(scripts/apply-tx-change-marks.ts --apply)가 적용돼 있어야 한다.
 * 이미 최신(저장 번호 = 현재 단지 번호)인 단지는 행을 읽지 않으므로 중간에 멈춰도 다시 돌리면 이어서 한다.
 * --all 이 모든 lawd 를 에러 없이 끝내면 갱신 기준 번호(snapshot_watermark 'apt_tx_hist')를 시작 시점 번호로 둔다.
 * 인코딩 왕복 불일치·비정상 payload·느린 쓰기(묶음 5초 초과)면 멈춘다(exit 2).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import {
  APT_TX_SNAPSHOT_DDL,
  AptTxSnapshotAnomaly,
  assertTxChangeTriggers,
  buildAptTxSnapshotsForLawd,
  readAptTxSnapshotWatermark,
  refreshAptTxSnapshots,
  writeAptTxSnapshotWatermark,
  type LawdBuildStats,
} from "../src/lib/db/apt-tx-snapshot";
import { readGlobalChangeSeq } from "../src/lib/db/snapshot-freshness";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const db = getDb();
  if (!db) {
    console.error("DB client unavailable. Set TURSO_DATABASE_URL.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
  const dryRun = !apply;
  const all = process.argv.includes("--all");
  const refresh = process.argv.includes("--refresh");
  const concurrency = Math.max(1, Math.min(4, Number(argValue("concurrency", "2")) || 2));
  const pauseMs = Math.max(0, Number(argValue("pause-ms", "1000")) || 0);
  const lawdArg = argValue("lawd", "");
  const log = (m: string) => console.log(m);

  if (apply) {
    await db.execute(APT_TX_SNAPSHOT_DDL);
    await assertTxChangeTriggers(db);
  }

  if (refresh) {
    const r = await refreshAptTxSnapshots(db, { dryRun, pauseMs, log });
    console.log(`[build] refresh ${JSON.stringify({ ...r, stats: r.stats.length })}`);
    process.exit(r.failedLawds.length ? 2 : 0);
  }

  let lawds: string[];
  if (lawdArg) {
    lawds = lawdArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (all) {
    const rs = await db.execute(`SELECT DISTINCT lawd_cd FROM sync_months ORDER BY lawd_cd`);
    lawds = rs.rows.map((r) => String(r.lawd_cd));
  } else {
    console.error("--lawd=... 또는 --all 또는 --refresh");
    process.exit(1);
  }

  // 갱신 기준: 빌드를 시작하기 전 전역 번호 — 이 뒤의 변경은 다음 갱신 목록에 나온다.
  const seqStart = apply ? await readGlobalChangeSeq(db) : null;
  console.log(`[build] lawds=${lawds.length} ${dryRun ? "DRY-RUN" : "APPLY"} concurrency=${concurrency} pauseMs=${pauseMs} seqStart=${seqStart ?? "-"}`);

  const stats: LawdBuildStats[] = [];
  const failed: string[] = [];
  let anomaly: Error | null = null;
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    while (!anomaly) {
      const i = next;
      next += 1;
      if (i >= lawds.length) return;
      try {
        stats.push(await buildAptTxSnapshotsForLawd(db!, lawds[i], { dryRun, pauseMs, log }));
      } catch (err) {
        failed.push(lawds[i]);
        console.error(`[build] ${lawds[i]} failed:`, err instanceof Error ? err.message : err);
        if (err instanceof AptTxSnapshotAnomaly) anomaly = err;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const sum = (k: keyof LawdBuildStats) => stats.reduce((a, s) => a + (Number(s[k]) || 0), 0);
  console.log(
    `[build] done lawds=${stats.length}/${lawds.length} apts=${sum("apts")} fresh=${sum("fresh")} rows=${sum("rowsRead")} ins=${sum("inserted")} upd=${sum("updated")} markOnly=${sum("markOnly")} del=${sum("deleted")} raced=${sum("raced")} payload=${(sum("payloadBytes") / 1024 / 1024).toFixed(1)}MB max=${(Math.max(0, ...stats.map((s) => s.maxPayloadBytes)) / 1024).toFixed(0)}KB ms=${Date.now() - t0}`,
  );

  if (apply && all && failed.length === 0 && seqStart != null) {
    const before = await readAptTxSnapshotWatermark(db);
    await writeAptTxSnapshotWatermark(db, seqStart);
    console.log(`[build] watermark ${before ?? "-"} → ${Math.max(before ?? 0, seqStart)}`);
  }
  if (failed.length) {
    console.error(`[build] failed lawds (${failed.length}): ${failed.join(",")}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
