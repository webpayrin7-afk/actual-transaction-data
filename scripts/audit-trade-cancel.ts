/**
 * READ ONLY: cancellation / identity collision inventory.
 * Small MOLIT sample. No persist.
 *
 *   npx tsx scripts/audit-trade-cancel.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { XMLParser } from "fast-xml-parser";
import { TRADE_API_URL } from "../src/lib/constants/regions";
import { parseTradeXml, getApiTotalCount } from "../src/lib/molit/parse";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import {
  classifyIdentityGroup,
  resolveActiveTrades,
} from "../src/lib/molit/trade-resolve";
import { YONGSAN_LAWD_CD } from "../src/lib/molit/sync-policy";

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  isArray: (name) => name === "item",
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function serviceKey(): string {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) throw new Error("MOLIT_API_KEY missing");
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

async function fetchXml(lawdCd: string, yearMonth: string): Promise<string> {
  const params = new URLSearchParams({
    LAWD_CD: lawdCd,
    DEAL_YMD: yearMonth,
    pageNo: "1",
    numOfRows: "1000",
  });
  const url = `${TRADE_API_URL}?serviceKey=${serviceKey()}&${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`MOLIT HTTP ${res.status}`);
  return res.text();
}

const SAMPLE: Array<{ lawd: string; ym: string; label: string }> = [
  { lawd: YONGSAN_LAWD_CD, ym: "202606", label: "yongsan-202606" },
  { lawd: "11680", ym: "202609", label: "gangnam-202609" },
  { lawd: "11710", ym: "202609", label: "songpa-202609" },
  { lawd: "41135", ym: "202608", label: "bundang-202608" },
  { lawd: "11680", ym: "202606", label: "gangnam-202606" },
];

async function main() {
  const cdealValues: Record<string, number> = {};
  const classCounts: Record<string, number> = {
    "cancellation-pair": 0,
    "exact-duplicate": 0,
    "aptDong-different": 0,
    other: 0,
  };
  const aptDongFilled = { empty: 0, filled: 0 };
  const cells: unknown[] = [];

  for (const cell of SAMPLE) {
    const xml = await fetchXml(cell.lawd, cell.ym);
    const json = parser.parse(xml);
    const rawItems = asArray<Record<string, unknown>>(
      json?.response?.body?.items?.item,
    );
    for (const row of rawItems) {
      const v = String(row.cdealType ?? "").trim() || "(empty)";
      cdealValues[v] = (cdealValues[v] ?? 0) + 1;
      const dong = String(row.aptDong ?? "").trim();
      if (dong) aptDongFilled.filled += 1;
      else aptDongFilled.empty += 1;
    }
    const parsed = parseTradeXml(xml, cell.lawd);
    const groups = new Map<string, typeof parsed>();
    for (const tx of parsed) {
      const k = naturalKeyFromTx(tx, cell.lawd);
      const list = groups.get(k);
      if (list) list.push(tx);
      else groups.set(k, [tx]);
    }
    const dupGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);
    const classified = dupGroups.map(([key, rows]) => {
      const kind = classifyIdentityGroup(rows);
      classCounts[kind] = (classCounts[kind] ?? 0) + 1;
      return {
        key,
        n: rows.length,
        kind,
        cdealType: rows.map((r) => r.ingestMeta?.cdealType ?? ""),
        cdealDay: rows.map((r) => r.ingestMeta?.cdealDay ?? ""),
        rgstDate: rows.map((r) => r.ingestMeta?.rgstDate ?? ""),
        aptDong: rows.map((r) => r.ingestMeta?.aptDong ?? ""),
        floor: rows.map((r) => r.floor),
        amount: rows.map((r) => r.dealAmount),
        area: rows.map((r) => r.exclusiveArea),
        dealDate: rows.map((r) => r.dealDate),
        apt: rows[0]?.aptName,
      };
    });
    const resolved = resolveActiveTrades(parsed, cell.lawd);
    cells.push({
      ...cell,
      apiTotalCount: getApiTotalCount(xml),
      raw: rawItems.length,
      parsed: parsed.length,
      uniqueKeys: groups.size,
      dupGroups: dupGroups.length,
      resolvedActive: resolved.active.length,
      cancelledExcluded: resolved.cancelledExcluded,
      cancelledOnlyDropped: resolved.cancelledOnlyDropped,
      classified,
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  let orphan = null;
  if (process.env.TURSO_DATABASE_URL) {
    const { getDb } = await import("../src/lib/db/client");
    const db = getDb();
    if (db) {
      const rows = await db.execute({
        sql: `SELECT apt_name, dong, jibun, floor, deal_date, deal_amount,
                     first_seen_at, last_seen_at, dealing_gbn
              FROM transactions
              WHERE lawd_cd=? AND year_month='202606' AND deal_type='trade'
                AND (
                  (apt_name LIKE '%리버힐삼성%' AND deal_date='2026-06-20')
                  OR (apt_name LIKE '%효창한신%' AND deal_date='2026-06-12')
                )`,
        args: [YONGSAN_LAWD_CD],
      });
      orphan = rows.rows;
    }
  }

  console.log(
    JSON.stringify(
      {
        persist: 0,
        cdealTypeInventory: cdealValues,
        aptDongFilled,
        classCounts,
        cells,
        yongsanOrphans: orphan,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
