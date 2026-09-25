/**
 * Read-only diagnosis of missing 공급면적 (supply area) coverage.
 *
 * - NO_TYPE: complexes in apt_complex_master with no apt_canonical_unit_types row.
 * - NO_SOURCE: complexes whose canonical rows include supply_cents = -1 placeholders.
 *
 * Identity for NO_TYPE complexes comes only from two deterministic official keys:
 *   1. complex_parcel_coordinates.pnu (EXACT_PNU / EXACT_PRIMARY_PARCEL, 연속지적도 PNU)
 *   2. MOLIT 실거래 jibun on transactions matching (lawd_cd, apt_name_norm, legal dong) exactly,
 *      combined with apt_complex_master.bjdong_cd. Only a single distinct jibun counts.
 * When both exist they must agree, otherwise the complex is held as PNU_CONFLICT.
 *
 * Writes data/poc/supply/supply-gap-report.json and data/poc/supply/fill-targets.jsonl.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/diagnose-supply-gaps.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";
import { parcelPnu, parseParcelJibun } from "../../src/lib/unit-type/official-expos";
import { decodeParcelPnu } from "../../src/lib/unit-type/supply-residual";

config({ path: ".env.local", quiet: true });

const OUT_DIR = "data/poc/supply";
const START_3Y = "2023-09-24";

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
/**
 * 연속지적도 PNU uses 대지=1 / 산=2 at position 11; 건축HUB (and every internal parcel key) uses
 * platGbCd 대지=0 / 산=1. Convert so both identities compare on the same convention.
 */
export function cadastralToRegistryPnu(pnu: string): string {
  if (!/^\d{19}$/.test(pnu)) return "";
  const land = pnu[10];
  const plat = land === "1" ? "0" : land === "2" ? "1" : "";
  if (!plat) return "";
  return `${pnu.slice(0, 10)}${plat}${pnu.slice(11)}`;
}
function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

export type FillTarget = {
  complexId: string;
  aptName: string;
  lawdCd: string;
  bjdongCd: string;
  pnu: string;
  identitySource: string;
  tx3y: number;
  trade3y: number;
};

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  mkdirSync(OUT_DIR, { recursive: true });

  // ---- coverage baseline -------------------------------------------------
  const coverage = (
    await db.execute(`
      WITH per AS (
        SELECT complex_id,
               SUM(supply_cents >= 0) AS supplied,
               SUM(status = 'NO_SOURCE') AS no_source
        FROM apt_canonical_unit_types GROUP BY complex_id
      )
      SELECT (SELECT COUNT(*) FROM apt_complex_master) AS master,
             COUNT(*) AS with_types,
             SUM(supplied > 0) AS any_supply,
             SUM(supplied > 0 AND no_source = 0) AS full_supply,
             SUM(supplied > 0 AND no_source > 0) AS partial_supply,
             SUM(supplied = 0) AS only_no_source
      FROM per`)
  ).rows[0]!;
  const trade3y = (
    await db.execute(`
      SELECT SUM(trade_count_3y) AS att3y,
             SUM(CASE WHEN resolution_status = 'NO_SOURCE' THEN trade_count_3y ELSE 0 END) AS nosrc3y,
             SUM(CASE WHEN resolution_status = 'NO_SOURCE' AND trade_count_3y > 0 THEN 1 ELSE 0 END) AS nosrc_pairs_traded
      FROM apt_unit_exclusive_pairs`)
  ).rows[0]!;

  // ---- NO_TYPE complexes ---------------------------------------------------
  const noType = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.sido, m.lawd_cd, m.bjdong_cd,
           m.legal_dong_name, m.jibun,
           c.pnu AS cpc_pnu, c.resolution_status AS cpc_status,
           (SELECT group_concat(source) FROM apt_complex_source_links l WHERE l.complex_id = m.complex_id) AS links
    FROM apt_complex_master m
    LEFT JOIN complex_parcel_coordinates c ON c.complex_id = m.complex_id
    WHERE NOT EXISTS (SELECT 1 FROM apt_canonical_unit_types u WHERE u.complex_id = m.complex_id)
  `);
  console.log(`no-type complexes: ${noType.rows.length}`);

  type TxAgg = { tx3y: number; trade3y: number; jibuns: string[] };
  const txAgg = new Map<string, TxAgg>();
  const rows = noType.rows;
  const CONC = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++]!;
      const r = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN deal_date > ? THEN 1 ELSE 0 END) AS tx3y,
                SUM(CASE WHEN deal_date > ? AND deal_type = 'trade' AND deal_amount > 0 THEN 1 ELSE 0 END) AS trade3y,
                group_concat(DISTINCT CASE WHEN jibun <> '' THEN jibun END) AS jibuns
              FROM transactions
              WHERE lawd_cd = ? AND apt_name_norm = ? AND dong = ?`,
        args: [START_3Y, START_3Y, str(row.lawd_cd), str(row.apt_name_norm), str(row.legal_dong_name)],
      });
      const agg = r.rows[0];
      txAgg.set(str(row.complex_id), {
        tx3y: num(agg?.tx3y),
        trade3y: num(agg?.trade3y),
        jibuns: str(agg?.jibuns).split(",").map((j) => j.trim()).filter(Boolean),
      });
      if (txAgg.size % 1000 === 0) console.log(`tx scan ${txAgg.size}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // (lawd_cd, apt_name_norm) uniqueness – transactions join by name, so shared names are ambiguous.
  const nameCounts = new Map<string, number>();
  for (const row of (await db.execute(`SELECT lawd_cd, apt_name_norm, legal_dong_name, COUNT(*) n FROM apt_complex_master GROUP BY 1,2,3`)).rows) {
    nameCounts.set(`${row.lawd_cd}|${row.apt_name_norm}|${row.legal_dong_name}`, num(row.n));
  }

  // PNUs already carrying supply (duplicate detection – same parcel already supplied under another complex id).
  const suppliedPnus = new Set<string>();
  for (const row of (await db.execute(`SELECT DISTINCT pnu FROM official_unit_area_cache`)).rows) suppliedPnus.add(str(row.pnu));

  const noTypeCauses: Record<string, number> = {};
  const noTypeCausesTx3y: Record<string, number> = {};
  const noTypeBySido: Record<string, { total: number; tx3y: number }> = {};
  const targets: FillTarget[] = [];
  const samples: Record<string, string[]> = {};
  for (const row of rows) {
    const complexId = str(row.complex_id);
    const agg = txAgg.get(complexId)!;
    const lawd = str(row.lawd_cd);
    const bjdong = str(row.bjdong_cd);
    const sido = str(row.sido);
    const slot = noTypeBySido[sido] ?? { total: 0, tx3y: 0 };
    slot.total += 1;
    if (agg.tx3y > 0) slot.tx3y += 1;
    noTypeBySido[sido] = slot;

    const cpcRegistry = cadastralToRegistryPnu(str(row.cpc_pnu));
    const cpc = decodeParcelPnu(cpcRegistry);
    const cpcPnu = cpc && cpc.lawdCd === lawd && cpc.bjdongCd === bjdong ? cpcRegistry : "";
    const cpcMismatch = Boolean(cpc) && !cpcPnu;
    let txPnu = "";
    let txMulti = false;
    const txJibuns = [...new Set(agg.jibuns)];
    if (txJibuns.length === 1) {
      const parcel = parseParcelJibun(txJibuns[0]!);
      if (parcel && bjdong) txPnu = parcelPnu(lawd, bjdong, parcel.platGbCd, parcel.bun, parcel.ji);
    } else if (txJibuns.length > 1) txMulti = true;
    const sharedName = (nameCounts.get(`${lawd}|${str(row.apt_name_norm)}|${str(row.legal_dong_name)}`) ?? 0) > 1;

    let cause: string;
    let pnu = "";
    let identitySource = "";
    if (cpcPnu && txPnu && cpcPnu !== txPnu) cause = "PNU_CONFLICT_CADASTRAL_VS_TRADE";
    else if (cpcPnu && txPnu) {
      cause = "PNU_BOTH_AGREE";
      pnu = cpcPnu;
      identitySource = "complex_parcel_coordinates+transactions_jibun";
    } else if (cpcPnu) {
      cause = "PNU_CADASTRAL_ONLY";
      pnu = cpcPnu;
      identitySource = "complex_parcel_coordinates";
    } else if (txPnu && !sharedName) {
      cause = "PNU_TRADE_JIBUN_ONLY";
      pnu = txPnu;
      identitySource = "transactions_jibun";
    } else if (txPnu && sharedName) cause = "TRADE_JIBUN_SHARED_NAME_HOLD";
    else if (txMulti) cause = "TRADE_MULTI_JIBUN_HOLD";
    else if (cpcMismatch) cause = "CADASTRAL_PNU_LAWD_MISMATCH";
    else cause = "NO_PARCEL_IDENTITY";
    if (pnu && suppliedPnus.has(pnu)) cause = "DUPLICATE_PARCEL_ALREADY_SUPPLIED";

    bump(noTypeCauses, cause);
    if (agg.tx3y > 0) bump(noTypeCausesTx3y, cause);
    const bucket = (samples[cause] ??= []);
    if (bucket.length < 5) bucket.push(`${complexId} ${str(row.apt_name)} ${lawd}/${bjdong} ${str(row.legal_dong_name)}`);
    if (pnu && cause !== "DUPLICATE_PARCEL_ALREADY_SUPPLIED") {
      targets.push({
        complexId,
        aptName: str(row.apt_name),
        lawdCd: lawd,
        bjdongCd: bjdong,
        pnu,
        identitySource,
        tx3y: agg.tx3y,
        trade3y: agg.trade3y,
      });
    }
  }
  targets.sort((a, b) => b.trade3y - a.trade3y || b.tx3y - a.tx3y || a.complexId.localeCompare(b.complexId));

  // ---- NO_SOURCE complexes ---------------------------------------------------
  const noSource = await db.execute(`
    WITH ns AS (
      SELECT complex_id,
             SUM(status = 'NO_SOURCE') AS ns_rows,
             SUM(supply_cents >= 0) AS supplied_rows
      FROM apt_canonical_unit_types GROUP BY complex_id HAVING ns_rows > 0
    ),
    tr AS (
      SELECT complex_id,
             SUM(CASE WHEN resolution_status = 'NO_SOURCE' THEN trade_count_3y ELSE 0 END) AS ns3y,
             MAX(CASE WHEN resolution_status = 'NO_SOURCE' THEN latest_trade_date END) AS ns_latest
      FROM apt_unit_exclusive_pairs GROUP BY complex_id
    )
    SELECT ns.complex_id, ns.ns_rows, ns.supplied_rows, COALESCE(tr.ns3y, 0) AS ns3y, tr.ns_latest,
           COALESCE(ck.detail, '') AS detail, COALESCE(ck.status, '') AS ck_status,
           COALESCE(r.api_class, '') AS api_class
    FROM ns
    LEFT JOIN tr ON tr.complex_id = ns.complex_id
    LEFT JOIN official_unit_area_checkpoint ck ON ck.complex_id = ns.complex_id
    LEFT JOIN apt_supply_identity_residual r ON r.complex_id = ns.complex_id
  `);
  const noSourceCauses: Record<string, { complexes: number; partialComplexes: number; complexesTraded3y: number; noSourceTrades3y: number; latestBefore2024: number }> = {};
  for (const row of noSource.rows) {
    const detail = str(row.detail);
    let cause: string;
    if (detail.startsWith("BULK_NO_ROWS")) cause = "PARCEL_HAS_NO_EXPOS_ROWS (bulk)";
    else if (detail.startsWith("API OFFICIAL_NO_DATA")) cause = "PARCEL_HAS_NO_EXPOS_ROWS (api)";
    else if (detail.startsWith("BULK_EVIDENCE_MERGE") || detail.startsWith("BULK supplies=")) cause = "EXCLUSIVE_NOT_IN_REGISTRY_TYPES";
    else if (detail.includes("IDENTITY")) cause = "REGISTRY_NAME_OR_PARCEL_MISMATCH";
    else if (detail.includes("SEMANTICS_UNCLEAR")) cause = "COMMON_AREA_SEMANTICS_UNCLEAR";
    else if (detail.includes("API_FAILED")) cause = "API_FAILED";
    else cause = `OTHER:${detail.slice(0, 24)}`;
    const slot = (noSourceCauses[cause] ??= { complexes: 0, partialComplexes: 0, complexesTraded3y: 0, noSourceTrades3y: 0, latestBefore2024: 0 });
    slot.complexes += 1;
    if (num(row.supplied_rows) > 0) slot.partialComplexes += 1;
    if (num(row.ns3y) > 0) slot.complexesTraded3y += 1;
    slot.noSourceTrades3y += num(row.ns3y);
    if (str(row.ns_latest) && str(row.ns_latest) < "2024-01-01") slot.latestBefore2024 += 1;
  }

  const conflicts = (await db.execute(`SELECT class, COUNT(*) AS n FROM apt_supply_conflict_class GROUP BY 1`)).rows.map((row) => ({
    class: str(row.class),
    n: num(row.n),
  }));
  const conflictComplexes = num((await db.execute(`SELECT COUNT(DISTINCT complex_id) n FROM apt_unit_supply_conflicts`)).rows[0]?.n);
  const state = (await db.execute(`SELECT * FROM apt_supply_incremental_state WHERE id = 1`)).rows[0];

  const report = {
    generatedAt: new Date().toISOString(),
    window3y: `deal_date > ${START_3Y}`,
    coverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, num(v)])),
    pairTrades3y: Object.fromEntries(Object.entries(trade3y).map(([k, v]) => [k, num(v)])),
    noType: {
      total: rows.length,
      withTx3y: [...txAgg.values()].filter((agg) => agg.tx3y > 0).length,
      withTrade3y: [...txAgg.values()].filter((agg) => agg.trade3y > 0).length,
      causes: noTypeCauses,
      causesWithTx3y: noTypeCausesTx3y,
      bySido: noTypeBySido,
      samples,
      fillTargets: targets.length,
      fillTargetsWithTrade3y: targets.filter((t) => t.trade3y > 0).length,
    },
    noSource: { total: noSource.rows.length, causes: noSourceCauses },
    conflicts: { byClass: conflicts, complexes: conflictComplexes, requiringReview: num(state?.conflicts_requiring_review) },
    incrementalState: state ? Object.fromEntries(Object.entries(state).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])) : null,
  };
  writeFileSync(`${OUT_DIR}/supply-gap-report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT_DIR}/fill-targets.jsonl`, targets.map((t) => JSON.stringify(t)).join("\n") + "\n");
  console.log(JSON.stringify({ coverage: report.coverage, noType: { ...report.noType, samples: undefined, bySido: undefined }, noSource: report.noSource }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
