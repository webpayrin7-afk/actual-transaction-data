/**
 * 국토부 OpenAPI 당월 데이터 vs DB 적재분 비교 → 재적재 필요 여부 판단
 *
 * 당월 sentinel만 보면 과거 계약월 late-report가 안 잡힌다.
 * workflow는 아침 06:00 KST + 18:00/23:00 KST에 force sync로 rolling window를 돌린다.
 * 이 스크립트의 기본은 여전히 당월 probe (15분 주기 비용 제한).
 *
 * 사용 예:
 *   npx tsx scripts/probe-molit-freshness.ts
 *   npx tsx scripts/probe-molit-freshness.ts --github-output
 *   npx tsx scripts/probe-molit-freshness.ts --force=1
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { FEATURED_LAWD_CODES } from "../src/lib/constants/regions-registry";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { fetchTradeMonthProbe } from "../src/lib/molit/client";
import { recentYearMonths } from "../src/lib/utils/format";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 전국 대표 법정동 — 갱신 감지용 (호출량 최소화) */
const DEFAULT_SENTINELS = [
  "11680", // 강남
  "11710", // 송파
  "41173", // 안양 동안
  "11230", // 동대문
];

async function dbTradeSnapshot(
  lawdCd: string,
  yearMonth: string,
): Promise<{ count: number; maxDealDate: string; syncedAt: string }> {
  const db = getDb();
  if (!db) return { count: -1, maxDealDate: "", syncedAt: "" };

  const sync = await db.execute({
    sql: `SELECT row_count, synced_at
          FROM sync_months
          WHERE lawd_cd = ? AND year_month = ? AND deal_kind = 'trade'`,
    args: [lawdCd, yearMonth],
  });
  const rowCount = Number(sync.rows[0]?.row_count ?? -1);
  const syncedAt = String(sync.rows[0]?.synced_at ?? "");

  const maxRes = await db.execute({
    sql: `SELECT MAX(deal_date) AS max_deal_date
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = 'trade'`,
    args: [lawdCd, yearMonth],
  });
  const maxDealDate = String(maxRes.rows[0]?.max_deal_date ?? "");

  return {
    count: Number.isFinite(rowCount) ? rowCount : -1,
    maxDealDate,
    syncedAt,
  };
}

function writeGithubOutput(values: Record<string, string>) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    for (const [k, v] of Object.entries(values)) {
      console.log(`::set-output name=${k}::${v}`);
    }
    return;
  }
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  appendFileSync(out, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const force = argValue("force", "0") === "1" || hasFlag("force");
  const githubOutput = hasFlag("github-output");
  const yearMonth = argValue("year-month", recentYearMonths(1)[0]);
  const codesArg = argValue("codes", "");
  const sentinels = codesArg
    ? codesArg.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_SENTINELS];

  // FEATURED에 없는 코드도 허용 — 기본 센티널이 우선
  void FEATURED_LAWD_CODES;

  if (!process.env.TURSO_DATABASE_URL) {
    process.env.TURSO_DATABASE_URL = `file:${resolve("data/molit.db")}`;
  }

  try {
    await ensureSchema();
  } catch (error) {
    console.warn("[probe] ensureSchema skipped:", error);
  }

  const reasons: string[] = [];
  const details: Array<{
    lawdCd: string;
    apiCount: number;
    dbCount: number;
    apiMax: string;
    dbMax: string;
    stale: boolean;
  }> = [];

  for (const lawdCd of sentinels) {
    try {
      const [api, dbSnap] = await Promise.all([
        fetchTradeMonthProbe(lawdCd, yearMonth),
        dbTradeSnapshot(lawdCd, yearMonth),
      ]);

      let stale = false;
      if (dbSnap.count < 0) {
        stale = true;
        reasons.push(`${lawdCd}: DB sync_months 없음`);
      } else if (api.count !== dbSnap.count) {
        stale = true;
        reasons.push(
          `${lawdCd}: 건수 API ${api.count} ≠ DB ${dbSnap.count}`,
        );
      } else if (
        api.maxDealDate &&
        dbSnap.maxDealDate &&
        api.maxDealDate > dbSnap.maxDealDate
      ) {
        stale = true;
        reasons.push(
          `${lawdCd}: 최근계약 API ${api.maxDealDate} > DB ${dbSnap.maxDealDate}`,
        );
      } else if (api.count > 0 && !dbSnap.syncedAt) {
        stale = true;
        reasons.push(`${lawdCd}: synced_at 없음`);
      }

      details.push({
        lawdCd,
        apiCount: api.count,
        dbCount: dbSnap.count,
        apiMax: api.maxDealDate,
        dbMax: dbSnap.maxDealDate,
        stale,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[probe] ${lawdCd} failed:`, message);
      details.push({
        lawdCd,
        apiCount: -1,
        dbCount: -1,
        apiMax: "",
        dbMax: "",
        stale: false,
      });
    }
    // 공공 API 429 완화
    await new Promise((r) => setTimeout(r, 400));
  }

  const shouldSync = force || reasons.length > 0;

  console.log(
    JSON.stringify(
      {
        yearMonth,
        force,
        shouldSync,
        reasonCount: reasons.length,
        reasons,
        details,
      },
      null,
      2,
    ),
  );

  if (githubOutput) {
    writeGithubOutput({
      should_sync: shouldSync ? "true" : "false",
      year_month: yearMonth,
      reason_count: String(reasons.length),
      summary: reasons.slice(0, 5).join(" | ") || "fresh",
    });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  if (hasFlag("github-output")) {
    // 개별 probe 실패와 달리 스크립트 붕괴 시에만 보수적으로 sync
    writeGithubOutput({
      should_sync: "true",
      year_month: recentYearMonths(1)[0],
      reason_count: "1",
      summary: "probe crashed — force sync",
    });
  }
  process.exit(0);
});
