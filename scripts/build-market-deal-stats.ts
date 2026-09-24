/**
 * 실거래 월간 사전 집계 market_monthly_deal_stats 빌드·갱신.
 * 이 테이블 외에는 쓰지 않는다 (transactions·sync_months는 읽기만).
 *
 *   npm run db:deal-stats                 # 최근 13개월 dry-run (쓰기 없음, 변경 건수만 보고)
 *   npm run db:deal-stats -- --apply      # 최근 13개월 재계산 → 바뀐 행만 upsert/삭제
 *   npm run db:deal-stats -- --mode=full  # 전체 기간 dry-run (연 단위 창)
 *   npm run db:deal-stats -- --mode=full --apply
 *
 * 옵션: --months=N (recent 창 길이, 기본 13) · --concurrency=N (기본 4)
 *       --dong-bands=all|all,small,mid,large|none (동 행 면적대, 기본 all)
 * 신고 기한(계약 후 30일)이 지나지 않은 달은 만들지 않는다 (trends.ts lastCompleteVolumeMonth와 같은 기준).
 * 같은 원자료로 다시 돌리면 변경 0건이어야 한다 (idempotent).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import {
  AREA_BANDS,
  DEAL_STATS_TABLE,
  type AreaBand,
  lastCompleteVolumeMonth,
  ymShift,
} from "../src/lib/market/deal-stats";
import {
  applyDiff,
  computeDealStatsWindow,
  diffRows,
  ensureDealStatsTable,
  loadCoverage,
  readExistingWindow,
  tableExists,
  type BuildWindow,
  type DealStatsRow,
} from "../src/lib/market/deal-stats-build";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "1";
}

/** 한 행을 SQLite 레코드로 저장할 때의 대략적 바이트 (키 문자열 + 정수 열) — 크기 추정용. */
function approxRowBytes(r: DealStatsRow): number {
  const text = r.scope.length + Buffer.byteLength(r.scope_key) + r.deal_kind.length + r.area_band.length + 6;
  const ints = 8 * 3 + 4 * 17;
  return text + ints + 6 + 24 + 20; // build_version + computed_at + 레코드 헤더
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL is not configured");
  const apply = arg("apply") === "1";
  const mode = arg("mode") === "full" ? "full" : "recent";
  const months = Math.max(1, Number(arg("months") ?? 13));
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 4));
  const dongArg = arg("dong-bands") ?? "all";
  const dongBands = (dongArg === "none" ? [] : dongArg.split(",")).filter((b): b is AreaBand =>
    (AREA_BANDS as string[]).includes(b),
  );
  const to = lastCompleteVolumeMonth();
  const started = performance.now();

  const coverage = await loadCoverage(db);
  let minYm = to;
  for (const m of Object.values(coverage)) for (const s of m.values()) for (const ym of s) if (ym < minYm) minYm = ym;

  const windows: BuildWindow[] = [];
  if (mode === "full") {
    for (let y = Number(minYm.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      windows.push({ from: `${y}01` < minYm ? minYm : `${y}01`, to: `${y}12` > to ? to : `${y}12` });
    }
  } else {
    windows.push({ from: ymShift(to, -(months - 1)), to });
  }

  if (apply) await ensureDealStatsTable(db);
  const computedAt = new Date().toISOString();
  const totals = { computed: 0, insert: 0, update: 0, remove: 0, unchanged: 0, bytes: 0 };
  const byScope = new Map<string, number>();

  console.log(JSON.stringify({ mode, apply, dongBands, lastCompleteMonth: to, windows: windows.length, concurrency }));
  for (const w of windows) {
    const t0 = performance.now();
    let fetched = 0;
    const rows = await computeDealStatsWindow(db, {
      window: w,
      coverage,
      concurrency,
      dongBands,
      onLawd: (i) => {
        fetched += i.rows;
      },
    });
    const tCompute = performance.now() - t0;
    const stale = new Set<string>();
    const existing = await readExistingWindow(db, w, stale);
    const diff = diffRows(rows, existing, stale);
    if (apply && (diff.insert.length || diff.update.length || diff.remove.length)) {
      await applyDiff(db, diff, computedAt);
    }
    for (const r of rows) {
      const k = `${r.scope}/${r.area_band}`;
      byScope.set(k, (byScope.get(k) ?? 0) + 1);
      totals.bytes += approxRowBytes(r);
    }
    totals.computed += rows.length;
    totals.insert += diff.insert.length;
    totals.update += diff.update.length;
    totals.remove += diff.remove.length;
    totals.unchanged += diff.unchanged;
    console.log(
      JSON.stringify({
        window: `${w.from}-${w.to}`,
        txRowsRead: fetched,
        computed: rows.length,
        insert: diff.insert.length,
        update: diff.update.length,
        remove: diff.remove.length,
        unchanged: diff.unchanged,
        computeSec: Math.round(tCompute / 100) / 10,
        totalSec: Math.round((performance.now() - t0) / 100) / 10,
      }),
    );
  }

  const summary: Record<string, unknown> = {
    mode,
    apply,
    ...totals,
    estimatedMB: Math.round((totals.bytes / 1024 / 1024) * 10) / 10,
    byScopeBand: Object.fromEntries([...byScope].sort()),
    elapsedSec: Math.round((performance.now() - started) / 100) / 10,
  };
  if (await tableExists(db)) {
    const t = await db.execute(
      `SELECT scope, COUNT(*) AS n, MIN(year_month) AS min_ym, MAX(year_month) AS max_ym
       FROM ${DEAL_STATS_TABLE} GROUP BY scope`,
    );
    summary.table = t.rows.map((r) => ({ ...r }));
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
