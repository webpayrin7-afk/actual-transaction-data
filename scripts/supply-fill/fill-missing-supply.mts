/**
 * Missing-only 공급면적 fill from official 건축물대장 전유공용면적 (건축HUB getBrExposPubuseAreaInfo).
 *
 * Targets
 *   G1 NO_TYPE  — complexes with no canonical unit types whose bulk run had no parcel
 *                 (checkpoint BULK_IDENTITY) or found no rows (BULK_NO_ROWS). Parcel from
 *                 diagnose-supply-gaps.mts (연속지적도 PNU and/or single 실거래 jibun).
 *   G2 NO_ROWS  — complexes with NO_SOURCE pairs whose parcel returned no registry rows
 *                 (BULK_NO_ROWS / API OFFICIAL_NO_DATA / API_FAILED). Parcel re-resolved from
 *                 the master jibun through the VWorld parcel geocoder (official PNU), because
 *                 master bjdong_cd is stale after sigungu reorganisations (화성·부천 …).
 *
 * Phases
 *   resolve — VWorld PNU for G2 (cached). No DB writes.
 *   fetch   — API pages to data/supply-fill-cache (resumable, stops on quota). No DB writes.
 *   plan    — dry-run: derive supplies and count planned writes. No DB writes.
 *   apply   — execute the same plan. Inserts only; updates only NO_SOURCE pair status and
 *             status/checkpoint metadata. Never overwrites a non-NULL supply, never deletes.
 *
 * Supply = 전유 + 주거공용 (deriveOfficialSupplies). Complex-level ambiguity (ratio < 0.9),
 * name mismatch, and exclusive groups that would change an existing verified supply are held.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/fill-missing-supply.mts <phase> [--limit N] [--group G1|G2] [--min-weight N]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  NO_SUPPLY_CENTS,
  resolutionStatus,
  type CanonicalUnitStatus,
} from "../../src/lib/unit-type/canonical";
import {
  deriveOfficialSupplies,
  parseParcelJibun,
  roundArea,
  type DerivationResult,
  type ExposRow,
} from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";
import {
  acceptVworld,
  apiStats,
  fetchExposParcel,
  probeExposParcel,
  QuotaError,
  readExposCache,
  vworldParcel,
} from "./official-sources";

config({ path: ".env.local", quiet: true });

const OUT_DIR = "data/poc/supply";
const TARGETS = `${OUT_DIR}/fill-targets.jsonl`;
const RESOLVED = `${OUT_DIR}/g2-resolved.json`;
const START_12M = "2025-09-24";
const START_3Y = "2023-09-24";
const RECOVERY = "supply_fill_api_2026_09";
const BATCH = 40;

type Target = {
  group: "G1" | "G2";
  complexId: string;
  aptName: string;
  pnu: string;
  identitySource: string;
  weight: number;
};

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function cents(area: number): number {
  return Math.round(area * 100);
}

function db(): Client {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

async function g1Targets(client: Client): Promise<Target[]> {
  if (!existsSync(TARGETS)) throw new Error(`run diagnose-supply-gaps.mts first (${TARGETS})`);
  const rows = readFileSync(TARGETS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { complexId: string; aptName: string; pnu: string; identitySource: string; trade3y: number; tx3y: number });
  const detail = new Map<string, string>();
  for (const part of chunks(rows.map((r) => r.complexId), 300)) {
    const res = await client.execute({
      sql: `SELECT complex_id, detail FROM official_unit_area_checkpoint WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const row of res.rows) detail.set(str(row.complex_id), str(row.detail));
  }
  // Bulk already evaluated parcels it had rows for (SEMANTICS_UNCLEAR); the API returns the same rows.
  return rows
    .filter((r) => {
      const d = detail.get(r.complexId) ?? "";
      return d === "BULK_IDENTITY" || d === "BULK_NO_ROWS" || d.startsWith("SUPPLY_FILL") || d === "";
    })
    .map((r) => ({
      group: "G1" as const,
      complexId: r.complexId,
      aptName: r.aptName,
      pnu: r.pnu,
      identitySource: r.identitySource,
      weight: r.trade3y * 10 + r.tx3y,
    }));
}

type G2Row = { complexId: string; aptName: string; sido: string; sigungu: string; dong: string; lawdCd: string; jibun: string; ns3y: number; detail: string };

async function g2Rows(client: Client): Promise<G2Row[]> {
  const res = await client.execute(`
    WITH ns AS (
      SELECT complex_id FROM apt_canonical_unit_types GROUP BY complex_id
      HAVING SUM(status = 'NO_SOURCE') > 0
    ),
    tr AS (
      SELECT complex_id, SUM(CASE WHEN resolution_status = 'NO_SOURCE' THEN trade_count_3y ELSE 0 END) AS ns3y
      FROM apt_unit_exclusive_pairs GROUP BY complex_id
    )
    SELECT m.complex_id, m.apt_name, m.sido, m.sigungu, m.legal_dong_name, m.lawd_cd, m.jibun,
           COALESCE(tr.ns3y, 0) AS ns3y, ck.detail
    FROM ns
    JOIN apt_complex_master m ON m.complex_id = ns.complex_id
    JOIN official_unit_area_checkpoint ck ON ck.complex_id = ns.complex_id
    LEFT JOIN tr ON tr.complex_id = ns.complex_id
    WHERE ck.detail LIKE 'BULK_NO_ROWS%' OR ck.detail LIKE 'API OFFICIAL_NO_DATA%'
       OR ck.detail LIKE 'API API_FAILED%' OR ck.detail LIKE 'SUPPLY_FILL%'
  `);
  return res.rows.map((row) => ({
    complexId: str(row.complex_id),
    aptName: str(row.apt_name),
    sido: str(row.sido),
    sigungu: str(row.sigungu),
    dong: str(row.legal_dong_name),
    lawdCd: str(row.lawd_cd),
    jibun: str(row.jibun),
    ns3y: num(row.ns3y),
    detail: str(row.detail),
  }));
}

type Resolution = { complexId: string; status: string; pnu: string; address: string; vworldText: string; vworldDetail: string };

async function resolvePhase(client: Client) {
  const minWeight = Number(arg("--min-weight") ?? 0);
  let rows = await g2Rows(client);
  rows.sort((a, b) => b.ns3y - a.ns3y || a.complexId.localeCompare(b.complexId));
  if (minWeight > 0) rows = rows.filter((row) => row.ns3y * 10 >= minWeight);
  const out: Resolution[] = [];
  const counts: Record<string, number> = {};
  let quota = false;
  for (const row of rows) {
    const address = `${row.sido} ${row.sigungu} ${row.dong} ${row.jibun}`.replace(/\s+/g, " ").trim();
    let res: Resolution;
    try {
      if (!row.jibun || !parseParcelJibun(row.jibun)) {
        res = { complexId: row.complexId, status: "BAD_JIBUN", pnu: "", address, vworldText: "", vworldDetail: "" };
      } else {
        const v = await vworldParcel(address);
        const verdict = acceptVworld(row, v);
        res = { complexId: row.complexId, status: verdict.reason, pnu: verdict.registryPnu, address, vworldText: v.text, vworldDetail: v.detail };
      }
    } catch (error) {
      if (error instanceof QuotaError) {
        quota = true;
        break;
      }
      throw error;
    }
    counts[res.status] = (counts[res.status] ?? 0) + 1;
    out.push(res);
    if (out.length % 100 === 0) console.log(JSON.stringify({ progress: `${out.length}/${rows.length}`, ...counts, vworldCalls: apiStats.vworldCalls }));
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RESOLVED, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ g2: rows.length, resolved: out.length, quotaStop: quota, counts, vworldCalls: apiStats.vworldCalls }));
}

async function g2Targets(client: Client): Promise<Target[]> {
  if (!existsSync(RESOLVED)) return [];
  const resolved = new Map((JSON.parse(readFileSync(RESOLVED, "utf8")) as Resolution[]).map((r) => [r.complexId, r]));
  const rows = await g2Rows(client);
  const out: Target[] = [];
  for (const row of rows) {
    const r = resolved.get(row.complexId);
    if (!r || r.status !== "OK") continue;
    out.push({ group: "G2", complexId: row.complexId, aptName: row.aptName, pnu: r.pnu, identitySource: "vworld_parcel_geocode(master_jibun)", weight: row.ns3y * 10 });
  }
  return out;
}

async function allTargets(client: Client): Promise<Target[]> {
  const group = arg("--group");
  const list: Target[] = [];
  if (!group || group === "G1") list.push(...(await g1Targets(client)));
  if (!group || group === "G2") list.push(...(await g2Targets(client)));
  list.sort((a, b) => b.weight - a.weight || a.complexId.localeCompare(b.complexId));
  const minWeight = Number(arg("--min-weight") ?? 0);
  const filtered = minWeight > 0 ? list.filter((t) => t.weight >= minWeight) : list;
  const limit = Number(arg("--limit") ?? 0);
  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function probePhase(client: Client) {
  const targets = await allTargets(client);
  const pnus = [...new Set(targets.map((t) => t.pnu))];
  const status: Record<string, number> = { probed: 0, failed: 0 };
  let quota = false;
  let cursor = 0;
  const workers = Number(arg("--workers") ?? 6);
  async function worker() {
    while (!quota && cursor < pnus.length) {
      const pnu = pnus[cursor++]!;
      try {
        await probeExposParcel(pnu);
        status.probed += 1;
      } catch (error) {
        if (error instanceof QuotaError) {
          quota = true;
          break;
        }
        status.failed += 1;
        console.log(JSON.stringify({ pnu, error: error instanceof Error ? error.message : "error" }));
      }
      if ((status.probed + status.failed) % 100 === 0) console.log(JSON.stringify({ progress: `${cursor}/${pnus.length}`, ...status, ...apiStats }));
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  const summary = { parcels: pnus.length, ...status, quotaStop: quota, ...apiStats };
  writeFileSync(`${OUT_DIR}/probe-summary.json`, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2));
  console.log(JSON.stringify(summary));
}

/** Parcels worth a full fetch, best trades-per-call first. Page 1 decides no-data / name mismatch cheaply. */
async function fetchOrder(client: Client): Promise<{ pnus: string[]; skipped: Record<string, number>; pages: number }> {
  const targets = await allTargets(client);
  const best = new Map<string, { weight: number; pages: number }>();
  const skipped: Record<string, number> = {};
  for (const t of targets) {
    const cached = readExposCache(t.pnu);
    if (!cached) {
      skipped.NOT_PROBED = (skipped.NOT_PROBED ?? 0) + 1;
      continue;
    }
    if (cached.complete) {
      skipped.ALREADY_COMPLETE = (skipped.ALREADY_COMPLETE ?? 0) + 1;
      continue;
    }
    const d = deriveOfficialSupplies(cached.rows, t.aptName);
    if (d.matchedRows === 0 && d.rejectedNameRows > 0) {
      skipped.PAGE1_NAME_MISMATCH = (skipped.PAGE1_NAME_MISMATCH ?? 0) + 1;
      continue;
    }
    const prev = best.get(t.pnu);
    best.set(t.pnu, { weight: Math.max(prev?.weight ?? 0, t.weight), pages: cached.pages });
  }
  const pnus = [...best.entries()]
    .sort((a, b) => b[1].weight / b[1].pages - a[1].weight / a[1].pages || a[1].pages - b[1].pages)
    .map(([pnu]) => pnu);
  const pages = [...best.values()].reduce((n, v) => n + v.pages - 1, 0);
  return { pnus, skipped, pages };
}

async function fetchPhase(client: Client) {
  const order = await fetchOrder(client);
  console.log(JSON.stringify({ toFetch: order.pnus.length, remainingPages: order.pages, skipped: order.skipped }));
  const maxCalls = Number(arg("--max-calls") ?? 0);
  const pnus = order.pnus;
  const status: Record<string, number> = { done: 0, cached: 0, failed: 0 };
  let quota = false;
  let cursor = 0;
  const workers = Number(arg("--workers") ?? 3);
  const started = Date.now();
  async function worker() {
    while (!quota && cursor < pnus.length) {
      if (maxCalls > 0 && apiStats.calls >= maxCalls) break;
      const pnu = pnus[cursor++]!;
      const cached = readExposCache(pnu);
      if (cached?.complete) {
        status.cached += 1;
        continue;
      }
      try {
        await fetchExposParcel(pnu);
        status.done += 1;
      } catch (error) {
        if (error instanceof QuotaError) {
          quota = true;
          break;
        }
        status.failed += 1;
        console.log(JSON.stringify({ pnu, error: error instanceof Error ? error.message : "error" }));
      }
      const n = status.done + status.failed;
      if (n % 25 === 0) {
        console.log(JSON.stringify({ progress: `${cursor}/${pnus.length}`, ...status, ...apiStats, min: Math.round((Date.now() - started) / 60000) }));
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  const summary = { parcels: pnus.length, cursor, ...status, quotaStop: quota, ...apiStats };
  writeFileSync(`${OUT_DIR}/fetch-summary.json`, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2));
  console.log(JSON.stringify(summary));
}

// ---------------------------------------------------------------------------
// Plan / apply
// ---------------------------------------------------------------------------

type Stmt = { sql: string; args: InArgs };

type ComplexPlan = {
  complexId: string;
  group: string;
  klass: string;
  detail: string;
  statements: Stmt[];
  newTypes: number;
  placeholders: number;
  newPairs: number;
  pairFills: number;
  heldExclusive: number;
  householdRows: number;
  tradedCovered3y: number;
  traded3y: number;
};

type TradedPair = { cents: number; count: number; c12: number; c3y: number; latest: string };

async function tradedPairs(client: Client, complexId: string): Promise<TradedPair[]> {
  const res = await client.execute({
    sql: `SELECT CAST(ROUND(t.exclusive_area * 100) AS INTEGER) AS cents, COUNT(*) AS c,
                 SUM(CASE WHEN t.deal_date > ? THEN 1 ELSE 0 END) AS c12,
                 SUM(CASE WHEN t.deal_date > ? THEN 1 ELSE 0 END) AS c3y,
                 MAX(t.deal_date) AS latest
          FROM apt_complex_master m
          JOIN transactions t ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm AND t.dong = m.legal_dong_name
          WHERE m.complex_id = ? AND t.deal_type = 'trade' AND t.exclusive_area > 0 AND t.deal_amount > 0
          GROUP BY 1`,
    args: [START_12M, START_3Y, complexId],
  });
  return res.rows.map((row) => ({ cents: num(row.cents), count: num(row.c), c12: num(row.c12), c3y: num(row.c3y), latest: str(row.latest) })).filter((p) => p.cents > 0);
}

function classify(fetch: { total: number; rows: ExposRow[] }, derived: DerivationResult): string {
  if (fetch.total === 0) return "OFFICIAL_NO_DATA";
  const exclusive = fetch.rows.filter((r) => r.exposPubuseGbCdNm === "전유" && r.mainAtchGbCdNm === "주건축물");
  if (derived.matchedRows === 0 && derived.rejectedNameRows > 0) return "REGISTRY_NAME_MISMATCH";
  if (exclusive.length > 0 && !exclusive.some((r) => r.mainPurpsCdNm === "아파트")) return "NOT_APARTMENT_USE";
  if (derived.units.length === 0) return "NO_UNIT_IDENTITY";
  if (!derived.distinguishable) {
    if (derived.supplies.length === 0 && derived.units.some((u) => u.derivable)) return "TYPES_BELOW_3_UNITS";
    return derived.supplies.length === 0 ? "NO_DERIVABLE_UNITS" : "COMMON_SEMANTICS_UNCLEAR";
  }
  return "RECOVERED";
}

function checkpointStatus(klass: string): string {
  if (klass === "RECOVERED") return "COMPLETE_DATA";
  if (klass === "REGISTRY_NAME_MISMATCH") return "IDENTITY_UNRESOLVED";
  return klass === "OFFICIAL_NO_DATA" ? "COMPLETE_NO_DATA" : "COMPLETE_DATA";
}

async function planComplex(client: Client, target: Target, now: string): Promise<ComplexPlan | null> {
  const fetched = readExposCache(target.pnu);
  if (!fetched?.complete) return null;
  const derived = deriveOfficialSupplies(fetched.rows, target.aptName);
  const klass = classify(fetched, derived);
  const sourceAsOf = fetched.rows.map((r) => str(r.crtnDay)).sort().at(-1) ?? "";
  const plan: ComplexPlan = {
    complexId: target.complexId,
    group: target.group,
    klass,
    detail: `SUPPLY_FILL ${klass} ratio=${derived.residentialCommonRatio.toFixed(3)} supplies=${derived.supplies.length}`,
    statements: [],
    newTypes: 0,
    placeholders: 0,
    newPairs: 0,
    pairFills: 0,
    heldExclusive: 0,
    householdRows: 0,
    tradedCovered3y: 0,
    traded3y: 0,
  };

  const existingRows = await client.execute({
    sql: `SELECT unit_type_id, exclusive_cents, supply_cents, status FROM apt_canonical_unit_types WHERE complex_id = ?`,
    args: [target.complexId],
  });
  const existing = new Map<number, Map<number, string>>();
  for (const row of existingRows.rows) {
    const ex = num(row.exclusive_cents);
    const bucket = existing.get(ex) ?? new Map<number, string>();
    bucket.set(num(row.supply_cents), str(row.unit_type_id));
    existing.set(ex, bucket);
  }
  if (target.group === "G1" && existing.size > 0) return null; // no longer a NO_TYPE complex
  if (klass !== "RECOVERED") return plan; // nothing verified → only the checkpoint records the outcome
  const pairRows = await client.execute({
    sql: `SELECT exclusive_cents, resolution_status, observed_from, trade_count_3y FROM apt_unit_exclusive_pairs WHERE complex_id = ?`,
    args: [target.complexId],
  });
  const pairs = new Map(pairRows.rows.map((row) => [num(row.exclusive_cents), { status: str(row.resolution_status), from: str(row.observed_from), c3y: num(row.trade_count_3y) }]));
  const traded = target.group === "G1" ? await tradedPairs(client, target.complexId) : [];

  const supplyByEx = new Map<number, typeof derived.supplies>();
  if (klass === "RECOVERED") {
    for (const supply of derived.supplies) {
      const list = supplyByEx.get(supply.exclusiveCents) ?? [];
      list.push(supply);
      supplyByEx.set(supply.exclusiveCents, list);
    }
  }

  // Physical unit counts per (exclusive, supply) for household semantics (counts.ts rules).
  const physical = new Map<string, { dong: string; floor: string; ho: string; ex: number; su: number | null }>();
  for (const unit of derived.units) {
    const key = `${unit.dong}\t${unit.floor}\t${unit.ho}`;
    if (physical.has(key)) continue;
    physical.set(key, {
      dong: unit.dong,
      floor: unit.floor,
      ho: unit.ho,
      ex: cents(unit.exclusiveArea),
      su: unit.derivable ? cents(roundArea(unit.exclusiveArea + unit.residentialCommonArea)) : null,
    });
  }
  const groupUnits = new Map<number, number>();
  const typeUnits = new Map<string, number>();
  for (const unit of physical.values()) {
    groupUnits.set(unit.ex, (groupUnits.get(unit.ex) ?? 0) + 1);
    if (unit.su != null) typeUnits.set(`${unit.ex}|${unit.su}`, (typeUnits.get(`${unit.ex}|${unit.su}`) ?? 0) + 1);
  }

  const allEx = new Set<number>([...supplyByEx.keys(), ...traded.map((t) => t.cents)]);
  const tradedByEx = new Map(traded.map((t) => [t.cents, t]));
  for (const ex of allEx) {
    const variants = supplyByEx.get(ex) ?? [];
    const prev = existing.get(ex) ?? new Map<number, string>();
    const positive = [...prev.keys()].filter((c) => c >= 0);
    if (variants.length > 0 && positive.length > 0) {
      // Would add a variant next to an existing verified supply → changes its status. Hold.
      if (variants.some((v) => !prev.has(v.supplyCents))) plan.heldExclusive += 1;
      continue;
    }
    const status: CanonicalUnitStatus = resolutionStatus(variants.length, false);
    const typeIds: Array<{ id: string; su: number | null; hh: number | null }> = [];
    for (const variant of variants) {
      if (prev.has(variant.supplyCents)) continue;
      const id = canonicalUnitTypeId(target.complexId, ex, variant.supplyCents);
      const supplyArea = areaFromCents(variant.supplyCents);
      const provenance = {
        formula: variant.formula,
        residential_common_area: variant.residentialCommonArea,
        household_count: variant.householdCount,
        recovery: RECOVERY,
        group: target.group,
        pnu: target.pnu,
        identity_source: target.identitySource,
        api_total_rows: fetched.total,
      };
      plan.statements.push({
        sql: `INSERT INTO apt_canonical_unit_types (
                unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'BldRgstHubService', ?, ?, 'building_registry_expos', ?, ?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        args: [
          id,
          target.complexId,
          areaFromCents(ex),
          ex,
          supplyArea,
          variant.supplyCents,
          canonicalSupplyPyeong(supplyArea),
          supplyPyeongDisplayLabel(supplyArea),
          variant.householdCount,
          `${target.pnu}:${ex}:${variant.supplyCents}`,
          sourceAsOf,
          status,
          variant.formula,
          JSON.stringify(provenance),
          now,
          now,
        ],
      });
      plan.statements.push({
        sql: `INSERT INTO official_unit_area_cache (
                complex_id, source_unit_id, source_provider, source_dataset, pnu, source_building_id,
                dong, floor, ho, exclusive_area, residential_common_area, other_common_area,
                explicit_supply_area, contract_area, source_key, source_as_of, fetched_at, provenance_json
              ) VALUES (?, ?, 'BldRgstHubService', 'getBrExposPubuseAreaInfo', ?, '', '', '', '', ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
              ON CONFLICT(complex_id, source_unit_id) DO NOTHING`,
        args: [
          target.complexId,
          `type:${ex}:${variant.supplyCents}`,
          target.pnu,
          variant.exclusiveArea,
          variant.residentialCommonArea,
          variant.supplyArea,
          `${target.pnu}:${ex}:${variant.supplyCents}`,
          sourceAsOf,
          now,
          JSON.stringify({ acquisition_method: "API", ...provenance }),
        ],
      });
      plan.newTypes += 1;
      typeIds.push({ id, su: variant.supplyCents, hh: typeUnits.get(`${ex}|${variant.supplyCents}`) ?? null });
    }
    const tradedPair = tradedByEx.get(ex);
    if (variants.length === 0 && tradedPair && prev.size === 0) {
      // Builder convention: an observed exclusive with no verified supply keeps a NO_SOURCE placeholder.
      const id = canonicalUnitTypeId(target.complexId, ex, NO_SUPPLY_CENTS);
      plan.statements.push({
        sql: `INSERT INTO apt_canonical_unit_types (
                unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, 'observed_exclusive', '', '', 'none', 'NO_SOURCE', 'none', ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        args: [id, target.complexId, areaFromCents(ex), ex, NO_SUPPLY_CENTS, JSON.stringify({ recovery: RECOVERY, fill_class: klass }), now, now],
      });
      plan.placeholders += 1;
      typeIds.push({ id, su: null, hh: null });
    }
    if (tradedPair) {
      plan.traded3y += tradedPair.c3y;
      if (variants.length > 0) plan.tradedCovered3y += tradedPair.c3y;
    } else if (pairs.get(ex)?.status === "NO_SOURCE") {
      plan.traded3y += pairs.get(ex)!.c3y;
      if (variants.length > 0) plan.tradedCovered3y += pairs.get(ex)!.c3y;
    }

    // Pairs ledger.
    const pair = pairs.get(ex);
    const from = tradedPair ? (variants.length ? "transactions+official_expos" : "transactions") : "official_expos";
    if (!pair) {
      plan.statements.push({
        sql: `INSERT INTO apt_unit_exclusive_pairs (
                complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
                latest_trade_date, resolution_status, supply_variant_count, observed_from
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
        args: [target.complexId, ex, areaFromCents(ex), tradedPair?.count ?? 0, tradedPair?.c12 ?? 0, tradedPair?.c3y ?? 0, tradedPair?.latest ?? "", status, variants.length, from],
      });
      plan.newPairs += 1;
    } else if (pair.status === "NO_SOURCE" && variants.length > 0) {
      plan.statements.push({
        sql: `UPDATE apt_unit_exclusive_pairs
              SET resolution_status = ?, supply_variant_count = ?, observed_from = observed_from || '+official_expos'
              WHERE complex_id = ? AND exclusive_cents = ? AND resolution_status = 'NO_SOURCE'`,
        args: [status, variants.length, target.complexId, ex],
      });
      plan.pairFills += 1;
    }

    // Household counts (unit_type_household_counts + unit_exclusive_group_counts), insert-only.
    if (typeIds.length > 0) {
      const unitGroup = groupUnits.get(ex) ?? null;
      const assigned = typeIds.reduce((n, t) => n + (t.hh ?? 0), 0);
      for (const t of typeIds) {
        const n = t.su == null ? null : t.hh;
        const countStatus =
          n != null && n > 0
            ? variants.length === 1
              ? "EXACT_SINGLE_VARIANT_COUNT"
              : "EXACT_VARIANT_COUNT"
            : (unitGroup ?? 0) > 0
              ? "EXCLUSIVE_GROUP_ONLY"
              : "NO_SOURCE";
        const uiSafe = countStatus === "EXACT_SINGLE_VARIANT_COUNT" || countStatus === "EXACT_VARIANT_COUNT" ? 1 : 0;
        plan.statements.push({
          sql: `INSERT INTO unit_type_household_counts (
                  complex_id, unit_type_id, exclusive_cents, supply_cents, household_count, count_status,
                  ui_safe, source, source_as_of, provenance_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'official_unit_area_cache.BldRgstHubService', ?, ?, ?, ?)
                ON CONFLICT(complex_id, unit_type_id) DO NOTHING`,
          args: [target.complexId, t.id, ex, t.su ?? NO_SUPPLY_CENTS, n != null && n > 0 ? n : null, countStatus, uiSafe, sourceAsOf, JSON.stringify({ physicalGroup: unitGroup, assigned: n ?? 0, recovery: RECOVERY }), now, now],
        });
        plan.householdRows += 1;
      }
      if (!existing.has(ex)) {
        const groupStatus =
          unitGroup != null && unitGroup > 0
            ? assigned === unitGroup
              ? variants.length === 1
                ? "EXACT_SINGLE_VARIANT_COUNT"
                : "EXACT_VARIANT_COUNT"
              : assigned > 0
                ? "PARTIAL_UNIT_EVIDENCE"
                : "EXCLUSIVE_GROUP_ONLY"
            : "NO_SOURCE";
        plan.statements.push({
          sql: `INSERT INTO unit_exclusive_group_counts (
                  complex_id, exclusive_cents, household_count, variant_count, count_status, source,
                  source_as_of, provenance_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'official_unit_area_cache.BldRgstHubService', ?, ?, ?)
                ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
          args: [target.complexId, ex, unitGroup, variants.length, groupStatus, sourceAsOf, JSON.stringify({ physical: unitGroup, assigned, recovery: RECOVERY }), now],
        });
      }
    }
  }
  return plan;
}

function metaStatements(plan: ComplexPlan, target: Target, total: number, now: string): Stmt[] {
  const out: Stmt[] = [
    {
      sql: `INSERT INTO official_unit_area_checkpoint (complex_id, status, page_cursor, total_count, detail, updated_at)
            VALUES (?, ?, 0, ?, ?, ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              status = excluded.status, total_count = excluded.total_count,
              detail = excluded.detail, updated_at = excluded.updated_at
            WHERE official_unit_area_checkpoint.detail <> excluded.detail`,
      args: [target.complexId, checkpointStatus(plan.klass), total, plan.detail.slice(0, 240), now],
    },
  ];
  if (target.group === "G1") {
    const p = target.pnu;
    out.push({
      sql: `UPDATE apt_supply_identity_residual
            SET status = 'IDENTITY_RECOVERED', pnu = ?, identity_source = ?, lawd_cd = ?, bjdong_cd = ?,
                plat_gb_cd = ?, bun = ?, ji = ?, api_class = ?, updated_at = ?
            WHERE complex_id = ? AND status = 'IDENTITY_STILL_MISSING'`,
      args: [p, target.identitySource, p.slice(0, 5), p.slice(5, 10), p.slice(10, 11), p.slice(11, 15), p.slice(15, 19), plan.klass === "RECOVERED" ? "RECOVERED_DATA" : plan.klass, now, target.complexId],
    });
  }
  return out;
}

async function planPhase(client: Client, apply: boolean) {
  const targets = await allTargets(client);
  const now = new Date().toISOString();
  const totals = {
    targets: targets.length,
    fetched: 0,
    notFetched: 0,
    skippedNowTyped: 0,
    byClass: {} as Record<string, number>,
    byGroupClass: {} as Record<string, number>,
    recoveredComplexes: 0,
    newTypes: 0,
    placeholders: 0,
    newPairs: 0,
    pairFills: 0,
    heldExclusive: 0,
    householdRows: 0,
    traded3y: 0,
    tradedCovered3y: 0,
    supplyStatements: 0,
    metaStatements: 0,
    appliedChanges: 0,
  };
  const perComplex: Array<Record<string, unknown>> = [];
  // Two complexes on the same registry parcel cannot be told apart by the API rows. Hold all of them,
  // including a parcel already carrying another complex's official supply.
  const pnuCount = new Map<string, number>();
  for (const t of targets) pnuCount.set(t.pnu, (pnuCount.get(t.pnu) ?? 0) + 1);
  const foreign = new Set<string>();
  for (const part of chunks([...pnuCount.keys()], 300)) {
    const res = await client.execute({
      sql: `SELECT pnu, complex_id FROM official_unit_area_cache WHERE pnu IN (${part.map(() => "?").join(",")}) GROUP BY pnu, complex_id`,
      args: part,
    });
    for (const row of res.rows) foreign.add(`${str(row.pnu)}|${str(row.complex_id)}`);
  }
  const foreignPnu = (pnu: string, complexId: string) =>
    [...foreign].some((key) => key.startsWith(`${pnu}|`) && key !== `${pnu}|${complexId}`);
  for (const target of targets) {
    const fetched = readExposCache(target.pnu);
    if (!fetched?.complete) {
      totals.notFetched += 1;
      continue;
    }
    totals.fetched += 1;
    if ((pnuCount.get(target.pnu) ?? 0) > 1 || foreignPnu(target.pnu, target.complexId)) {
      totals.byClass.SHARED_PARCEL_HOLD = (totals.byClass.SHARED_PARCEL_HOLD ?? 0) + 1;
      continue;
    }
    const plan = await planComplex(client, target, now);
    if (!plan) {
      totals.skippedNowTyped += 1;
      continue;
    }
    totals.byClass[plan.klass] = (totals.byClass[plan.klass] ?? 0) + 1;
    totals.byGroupClass[`${target.group}:${plan.klass}`] = (totals.byGroupClass[`${target.group}:${plan.klass}`] ?? 0) + 1;
    if (plan.newTypes > 0) totals.recoveredComplexes += 1;
    totals.newTypes += plan.newTypes;
    totals.placeholders += plan.placeholders;
    totals.newPairs += plan.newPairs;
    totals.pairFills += plan.pairFills;
    totals.heldExclusive += plan.heldExclusive;
    totals.householdRows += plan.householdRows;
    totals.traded3y += plan.traded3y;
    totals.tradedCovered3y += plan.tradedCovered3y;
    totals.supplyStatements += plan.statements.length;
    const meta = metaStatements(plan, target, fetched.total, now);
    perComplex.push({ complexId: plan.complexId, group: plan.group, klass: plan.klass, newTypes: plan.newTypes, pairFills: plan.pairFills, newPairs: plan.newPairs, held: plan.heldExclusive, traded3y: plan.traded3y, covered3y: plan.tradedCovered3y });
    if (apply) {
      const statements = [...plan.statements, ...meta];
      for (const part of chunks(statements, BATCH)) {
        const results = await client.batch(part, "write");
        totals.appliedChanges += results.reduce((n, r) => n + r.rowsAffected, 0);
      }
    } else {
      // Count only meta writes that would change something.
      const ck = await client.execute({ sql: `SELECT detail FROM official_unit_area_checkpoint WHERE complex_id = ?`, args: [target.complexId] });
      if (str(ck.rows[0]?.detail) !== plan.detail.slice(0, 240)) totals.metaStatements += 1;
    }
  }
  const file = `${OUT_DIR}/${apply ? "apply" : "plan"}-${arg("--group") ?? "all"}.json`;
  writeFileSync(file, JSON.stringify({ at: now, apply, totals, perComplex }, null, 1));
  console.log(JSON.stringify({ apply, ...totals }, null, 2));
}

async function main() {
  const phase = process.argv[2] ?? "plan";
  const client = db();
  mkdirSync(OUT_DIR, { recursive: true });
  if (phase === "resolve") await resolvePhase(client);
  else if (phase === "probe") await probePhase(client);
  else if (phase === "fetch") await fetchPhase(client);
  else if (phase === "plan") await planPhase(client, false);
  else if (phase === "apply") await planPhase(client, true);
  else if (phase === "targets") {
    const t = await allTargets(client);
    const byGroup: Record<string, { n: number; weighted: number }> = {};
    for (const x of t) {
      const s = (byGroup[x.group] ??= { n: 0, weighted: 0 });
      s.n += 1;
      if (x.weight > 0) s.weighted += 1;
    }
    console.log(JSON.stringify({ targets: t.length, uniquePnus: new Set(t.map((x) => x.pnu)).size, byGroup }));
  } else throw new Error(`unknown phase ${phase}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  });
}
