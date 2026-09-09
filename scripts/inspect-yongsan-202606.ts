/**
 * READ ONLY: Yongsan 202606 raw MOLIT vs warehouse identity.
 * Does not persist. Does not run production sync.
 *
 *   npx tsx scripts/inspect-yongsan-202606.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { XMLParser } from "fast-xml-parser";
import { TRADE_API_URL } from "../src/lib/constants/regions";
import { parseTradeXml, getApiTotalCount } from "../src/lib/molit/parse";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { resolveActiveTrades } from "../src/lib/molit/trade-resolve";
import { isSameTransactionContent, snapshotFromTx } from "../src/lib/db/sync-diff";
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

function isMijubCandidate(row: Record<string, unknown>): boolean {
  const name = String(row.aptNm ?? "").replace(/\s+/g, "");
  const area = Number(row.excluUseAr) || 0;
  const amount = Number(String(row.dealAmount ?? "").replaceAll(",", ""));
  const y = String(row.dealYear ?? "");
  const m = String(row.dealMonth ?? "");
  const d = String(row.dealDay ?? "");
  return (
    name.includes("미주") &&
    Math.abs(area - 149.09) < 0.05 &&
    amount === 178000 &&
    y === "2026" &&
    String(Number(m)) === "6" &&
    String(Number(d)) === "30"
  );
}

function diffRecords(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Array<{ field: string; a: unknown; b: unknown }> {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: Array<{ field: string; a: unknown; b: unknown }> = [];
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ field: k, a: av, b: bv });
    }
  }
  return out;
}

async function main() {
  const xml = await fetchXml(YONGSAN_LAWD_CD, "202606");
  const json = parser.parse(xml);
  const rawItems = asArray<Record<string, unknown>>(
    json?.response?.body?.items?.item,
  );
  const parsed = parseTradeXml(xml, YONGSAN_LAWD_CD);
  const resolved = resolveActiveTrades(parsed, YONGSAN_LAWD_CD);
  const rawKeys = [...new Set(rawItems.flatMap((r) => Object.keys(r)))].sort();

  const mijubRaw = rawItems.filter(isMijubCandidate);
  const mijubParsed = parsed.filter(
    (tx) =>
      tx.aptName.replace(/\s+/g, "").includes("미주") &&
      Math.abs(tx.exclusiveArea - 149.09) < 0.05 &&
      tx.dealAmount === 178000 &&
      tx.dealDate === "2026-06-30",
  );

  const mijubIdentities = mijubParsed.map((tx) => ({
    floor: tx.floor,
    jibun: tx.jibun,
    dong: tx.dong,
    dealingGbn: tx.dealingGbn,
    buildYear: tx.buildYear,
    parserId: tx.id,
    naturalKey: naturalKeyFromTx(tx, YONGSAN_LAWD_CD),
  }));
  const uniqueMijubKeys = [...new Set(mijubIdentities.map((r) => r.naturalKey))];

  const allKeys = parsed.map((tx) => naturalKeyFromTx(tx, YONGSAN_LAWD_CD));
  const uniqueAll = new Set(allKeys);

  let warehouse = {
    txCount: -1,
    syncRowCount: -1,
    mijubRows: [] as Array<Record<string, unknown>>,
  };
  if (process.env.TURSO_DATABASE_URL) {
    const { getDb } = await import("../src/lib/db/client");
    const db = getDb();
    if (db) {
      const cnt = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM transactions
              WHERE lawd_cd=? AND year_month='202606' AND deal_type='trade'`,
        args: [YONGSAN_LAWD_CD],
      });
      const sync = await db.execute({
        sql: `SELECT row_count, synced_at FROM sync_months
              WHERE lawd_cd=? AND year_month='202606' AND deal_kind='trade'`,
        args: [YONGSAN_LAWD_CD],
      });
      const mijub = await db.execute({
        sql: `SELECT id, apt_name, dong, jibun, floor, exclusive_area,
                     deal_amount, deal_date, dealing_gbn, first_seen_at, last_seen_at
              FROM transactions
              WHERE lawd_cd=? AND year_month='202606' AND deal_type='trade'
                AND deal_date='2026-06-30' AND deal_amount=178000`,
        args: [YONGSAN_LAWD_CD],
      });
      warehouse = {
        txCount: Number(cnt.rows[0]?.n ?? 0),
        syncRowCount: Number(sync.rows[0]?.row_count ?? -1),
        mijubRows: mijub.rows.map((r) => ({ ...r })),
      };

      const existing = await db.execute({
        sql: `SELECT id, deal_date, apt_name, gu, dong, jibun, floor,
                     exclusive_area, deal_amount, monthly_rent, dealing_gbn,
                     build_year, first_seen_at
              FROM transactions
              WHERE lawd_cd=? AND year_month='202606' AND deal_type='trade'`,
        args: [YONGSAN_LAWD_CD],
      });
      const byNatural = new Map<string, (typeof existing.rows)[number]>();
      for (const row of existing.rows) {
        const nk = [
          "trade",
          YONGSAN_LAWD_CD,
          String(row.dong ?? "").trim(),
          String(row.jibun ?? "").trim(),
          String(row.apt_name ?? "").replace(/\s+/g, "").toLowerCase(),
          String(Number(row.floor) || 0),
          String(Math.round((Number(row.exclusive_area) || 0) * 100) / 100),
          String(Number(row.deal_amount) || 0),
          "0",
          String(row.deal_date).slice(0, 10),
        ].join("|");
        if (!byNatural.has(nk)) byNatural.set(nk, row);
      }

      const seen = new Set<string>();
      let wouldInsert = 0;
      let wouldUpdate = 0;
      let wouldUnchanged = 0;
      let batchDupSkip = 0;
      const keepIds = new Set<string>();
      for (const tx of resolved.active) {
        const nk = naturalKeyFromTx(tx, YONGSAN_LAWD_CD);
        if (seen.has(nk)) {
          batchDupSkip += 1;
          continue;
        }
        seen.add(nk);
        const matched = byNatural.get(nk);
        if (!matched) {
          wouldInsert += 1;
          continue;
        }
        keepIds.add(String(matched.id));
        const existingSnap = {
          dealDate: String(matched.deal_date).slice(0, 10),
          aptName: String(matched.apt_name),
          gu: String(matched.gu ?? ""),
          dong: String(matched.dong ?? ""),
          exclusiveArea: Number(matched.exclusive_area) || 0,
          dealAmount: Number(matched.deal_amount) || 0,
          monthlyRent: Number(matched.monthly_rent) || 0,
          floor: Number(matched.floor) || 0,
          buildYear:
            matched.build_year == null || matched.build_year === ""
              ? null
              : Number(matched.build_year),
          jibun: String(matched.jibun ?? ""),
          dealingGbn: String(matched.dealing_gbn ?? ""),
        };
        const incoming = snapshotFromTx(tx);
        if (isSameTransactionContent(existingSnap, incoming)) wouldUnchanged += 1;
        else wouldUpdate += 1;
      }
      const wouldDeleteRows = existing.rows
        .filter((r) => !keepIds.has(String(r.id)))
        .map((r) => ({
          id: String(r.id),
          apt: String(r.apt_name),
          floor: Number(r.floor),
          amount: Number(r.deal_amount),
          date: String(r.deal_date),
        }));
      const wouldDelete = wouldDeleteRows.length;

      const mijubSeen = new Set<string>();
      let mijubWouldInsert = 0;
      for (const tx of mijubParsed) {
        const nk = naturalKeyFromTx(tx, YONGSAN_LAWD_CD);
        if (mijubSeen.has(nk)) continue;
        mijubSeen.add(nk);
        if (!byNatural.has(nk)) mijubWouldInsert += 1;
      }

      const cancelPairs = rawItems.filter(
        (r) => String(r.cdealType ?? "").trim() !== "",
      ).length;

      console.log(
        JSON.stringify(
          {
            persist: 0,
            rawItemCount: rawItems.length,
            apiTotalCount: getApiTotalCount(xml),
            parsedRows: parsed.length,
            uniqueIdentityRows: uniqueAll.size,
            resolvedActive: resolved.active.length,
            cancelledExcluded: resolved.cancelledExcluded,
            batchDupSkipWould: parsed.length - uniqueAll.size,
            warehouseTxCount: warehouse.txCount,
            syncMonthsRowCount: warehouse.syncRowCount,
            missingUniqueIdentities: Math.max(0, uniqueAll.size - existing.rows.length),
            warehouseIdentitiesNotInApi: existing.rows.length - (uniqueAll.size - (mijubWouldInsert > 0 ? 1 : 0)),
            cancelTypedRawRows: cancelPairs,
            rawFieldNames: rawKeys,
            mijub: {
              rawMatches: mijubRaw.length,
              parsedMatches: mijubParsed.length,
              uniqueIdentityRows: uniqueMijubKeys.length,
              identities: mijubIdentities,
              rawRows: mijubRaw,
              fieldDiffs:
                mijubRaw.length === 2 ? diffRecords(mijubRaw[0], mijubRaw[1]) : [],
              warehouseRows: warehouse.mijubRows,
            },
            dryRunMonth: {
              wouldInsert,
              wouldUpdate,
              wouldUnchanged,
              wouldDelete,
              wouldDeleteRows,
              batchDupSkip,
              mijubWouldInsert,
              firstSeenOnInsert: "now (discovery=1), never backdated to deal_date",
              lastSeenOnInsert: "now",
              lastSeenOnUnchanged: "preserved",
            },
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  console.log(
    JSON.stringify(
      {
        persist: 0,
        warehouse: "unavailable",
        rawItemCount: rawItems.length,
        parsedRows: parsed.length,
        uniqueIdentityRows: uniqueAll.size,
        rawFieldNames: rawKeys,
        mijubRaw: mijubRaw,
        mijubIdentities,
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
