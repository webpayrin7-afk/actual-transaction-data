/**
 * MOLIT → Turso/SQLite 웨어하우스 적재
 *
 * 사용 예:
 *   TURSO_DATABASE_URL=file:./data/molit.db npx tsx scripts/sync-molit.ts
 *   TURSO_DATABASE_URL=file:./data/molit.db npx tsx scripts/sync-molit.ts --scope=featured --trade-months=120 --rent-months=48
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/sync-molit.ts --scope=all --trade-months=36
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { resolve } from "node:path";
import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
} from "../src/lib/constants/regions-registry";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  fetchOneTradeForSync,
  fetchOneRentForSync,
} from "../src/lib/molit/client";
import { recentYearMonths } from "../src/lib/utils/format";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function expandFeatured(): string[] {
  const featured = new Set<string>(FEATURED_LAWD_CODES);
  const codes = new Set<string>();
  for (const region of ALL_REGIONS) {
    if (region.lawdCodes.some((c) => featured.has(c))) {
      for (const c of region.lawdCodes) codes.add(c);
    }
  }
  return [...codes];
}

function allLawdCodes(): string[] {
  return [...new Set(ALL_REGIONS.flatMap((r) => r.lawdCodes))];
}

async function main() {
  const scope = argValue("scope", "featured"); // featured | all | anyang | codes
  const tradeMonths = Number(argValue("trade-months", "120"));
  const rentMonths = Number(argValue("rent-months", "48"));
  const concurrency = Number(argValue("concurrency", "4"));
  const codesArg = argValue("codes", "");

  if (!process.env.TURSO_DATABASE_URL) {
    // 로컬 기본 파일 DB
    process.env.TURSO_DATABASE_URL = `file:${resolve("data/molit.db")}`;
  }
  process.env.MOLIT_SYNCING = "1";

  const db = getDb();
  if (!db) {
    console.error("DB client unavailable. Set TURSO_DATABASE_URL.");
    process.exit(1);
  }
  await ensureSchema(db);

  let lawdCodes: string[];
  if (codesArg) {
    lawdCodes = codesArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (scope === "all") {
    lawdCodes = allLawdCodes();
  } else if (scope === "anyang") {
    lawdCodes = ["41171", "41173"];
  } else {
    lawdCodes = expandFeatured();
  }

  const tradeYms = recentYearMonths(Math.min(Math.max(tradeMonths, 1), 120));
  const rentYms = recentYearMonths(Math.min(Math.max(rentMonths, 0), 120));

  type Job = {
    lawdCd: string;
    yearMonth: string;
    kind: "trade" | "rent";
  };
  const jobs: Job[] = [];
  for (const lawdCd of lawdCodes) {
    for (const yearMonth of tradeYms) {
      jobs.push({ lawdCd, yearMonth, kind: "trade" });
    }
    for (const yearMonth of rentYms) {
      jobs.push({ lawdCd, yearMonth, kind: "rent" });
    }
  }

  console.log(
    `[sync] lawds=${lawdCodes.length} jobs=${jobs.length} tradeMonths=${tradeYms.length} rentMonths=${rentYms.length}`,
  );

  let done = 0;
  let rows = 0;
  let failures = 0;
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      try {
        const items =
          job.kind === "trade"
            ? await fetchOneTradeForSync(job.lawdCd, job.yearMonth)
            : await fetchOneRentForSync(job.lawdCd, job.yearMonth);
        await replaceMonthTransactions({
          lawdCd: job.lawdCd,
          yearMonth: job.yearMonth,
          dealKind: job.kind,
          items,
        });
        rows += items.length;
      } catch (err) {
        failures += 1;
        console.warn(
          `[sync] fail ${job.kind} ${job.lawdCd} ${job.yearMonth}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        done += 1;
        if (done % 25 === 0 || done === jobs.length) {
          console.log(
            `[sync] progress ${done}/${jobs.length} rows=${rows} failures=${failures}`,
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  console.log(
    `[sync] done jobs=${done} rows=${rows} failures=${failures} db=${process.env.TURSO_DATABASE_URL}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
