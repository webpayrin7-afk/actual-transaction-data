/**
 * Official expos acquisition for apt_unit_acquisition_manifest.
 * Supply = exclusive + residential common only. Does not overwrite a positive supply.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/acquire-official-supply.mts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  NO_SUPPLY_CENTS,
  resolutionStatus,
} from "../../src/lib/unit-type/canonical";
import {
  deriveOfficialSupplies,
  parcelPnu,
  parseParcelJibun,
  priorityRank,
  type DerivedSupply,
  type ExposRow,
} from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const MIGRATION = "src/lib/db/migrations/20260924_official_unit_area.sql";
const PARTIAL = "/tmp/official-unit-area/partial";
const AS_OF = "2026-09-17";
const START_12M = "2025-09-17";
const PAGE_SIZE = 100;
const BATCH = 40;
const JAMSIL_REQUIRED: Array<[number, number]> = [
  [8480, 11152],
  [8488, 10929],
  [8497, 10947],
];

type ManifestRow = {
  complexId: string;
  aptName: string;
  lawdCd: string;
  bjdongCd: string;
  jibun: string;
  recent: number;
};

type CheckpointStatus =
  | "COMPLETE_DATA"
  | "COMPLETE_NO_DATA"
  | "IDENTITY_UNRESOLVED"
  | "API_FAILED"
  | "RATE_LIMIT_HOLD";

const stats = {
  attempted: 0,
  completeData: 0,
  completeNoData: 0,
  identityUnresolved: 0,
  apiFailed: 0,
  rateHold: 0,
  calls: 0,
  http429: 0,
  retries: 0,
  cacheRows: 0,
  supplyFills: 0,
  variants: 0,
  newTypes: 0,
  conflicts: 0,
  positiveOverwrites: 0,
};

let spacingMs = 160;
let nextSlot = 0;
let consecutive429 = 0;
let hardStop = "";

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + spacingMs;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]) {
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH), "write");
  }
}

async function fetchPage(parcel: { sigunguCd: string; bjdongCd: string; platGbCd: string; bun: string; ji: string }, page: number) {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const qs = new URLSearchParams({
    sigunguCd: parcel.sigunguCd,
    bjdongCd: parcel.bjdongCd,
    platGbCd: parcel.platGbCd,
    bun: parcel.bun,
    ji: parcel.ji,
    numOfRows: String(PAGE_SIZE),
    pageNo: String(page),
    _type: "json",
  });
  let last = "unknown";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await pace();
    stats.calls += 1;
    const res = await fetch(
      `https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?serviceKey=${key}&${qs}`,
      { headers: { "User-Agent": "ziplab-supply" } },
    );
    const text = await res.text();
    if (res.status === 429 || text.includes("LIMIT") || text.includes("한도")) {
      stats.http429 += 1;
      consecutive429 += 1;
      spacingMs = Math.min(1500, Math.round(spacingMs * 1.5));
      stats.retries += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20000, 1500 * (attempt + 1))));
      last = `429 spacing=${spacingMs}`;
      if (consecutive429 >= 25) {
        hardStop = "RATE_LIMIT_HOLD";
        throw new Error("RATE_LIMIT_HOLD");
      }
      continue;
    }
    consecutive429 = 0;
    if (!res.ok) {
      stats.retries += 1;
      last = `HTTP ${res.status}`;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    let parsed: { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { totalCount?: unknown; items?: { item?: unknown } } } };
    try {
      parsed = JSON.parse(text);
    } catch {
      stats.retries += 1;
      last = "non-json";
      continue;
    }
    const header = parsed.response?.header;
    const code = str(header?.resultCode);
    const msg = str(header?.resultMsg);
    if (msg.includes("한도") || msg.includes("LIMIT") || msg.includes("트래픽")) {
      hardStop = "QUOTA";
      throw new Error("QUOTA");
    }
    if (code && code !== "00" && code !== "0" && code !== "000" && code !== "03") {
      stats.retries += 1;
      last = `API ${code}`;
      continue;
    }
    const total = num(parsed.response?.body?.totalCount);
    const raw = parsed.response?.body?.items?.item;
    const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as ExposRow[];
    return { total, items };
  }
  throw new Error(last);
}

async function fetchAll(complexId: string, parcel: { sigunguCd: string; bjdongCd: string; platGbCd: string; bun: string; ji: string }) {
  const dir = `${PARTIAL}/${complexId}`;
  mkdirSync(dir, { recursive: true });
  const rows: ExposRow[] = [];
  let total = 0;
  let highest = 0;
  if (existsSync(`${dir}/total.txt`)) total = Number(readFileSync(`${dir}/total.txt`, "utf8"));
  for (const name of readdirSync(dir)) {
    const match = /^p(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pageNo = Number(match[1]);
    highest = Math.max(highest, pageNo);
    rows.push(...(JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as ExposRow[]));
  }
  let nextPage = highest + 1;
  if (highest === 0) {
    const first = await fetchPage(parcel, 1);
    total = first.total;
    writeFileSync(`${dir}/p1.json`, JSON.stringify(first.items));
    writeFileSync(`${dir}/total.txt`, String(total));
    rows.push(...first.items);
    nextPage = 2;
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total > 120000) throw new Error(`page volume ${total}`);
  while (nextPage <= pages) {
    if (hardStop) throw new Error(hardStop);
    const chunk: number[] = [];
    for (let i = 0; i < 8 && nextPage + i <= pages; i += 1) chunk.push(nextPage + i);
    const results = await Promise.all(chunk.map((pageNo) => fetchPage(parcel, pageNo)));
    chunk.forEach((pageNo, index) => {
      const items = results[index]!.items;
      writeFileSync(`${dir}/p${pageNo}.json`, JSON.stringify(items));
      rows.push(...items);
    });
    nextPage += chunk.length;
  }
  return { rows, total, pages };
}

type Existing = Map<number, Map<number, string>>;

function groupSupplies(supplies: DerivedSupply[]) {
  const byExclusive = new Map<number, DerivedSupply[]>();
  for (const supply of supplies) {
    const list = byExclusive.get(supply.exclusiveCents);
    if (list) list.push(supply);
    else byExclusive.set(supply.exclusiveCents, [supply]);
  }
  return byExclusive;
}

async function applySupplies(
  db: Client,
  complexId: string,
  pnu: string,
  supplies: DerivedSupply[],
  existing: Existing,
  now: string,
) {
  const statements: { sql: string; args: InArgs }[] = [];
  const byExclusive = groupSupplies(supplies);
  for (const [exCents, variants] of byExclusive) {
    const prev = existing.get(exCents) ?? new Map<number, string>();
    const positive = [...prev.keys()].filter((cents) => cents >= 0);
    const fresh = variants.filter((variant) => !prev.has(variant.supplyCents));
    const combined = new Set<number>([...positive, ...variants.map((variant) => variant.supplyCents)]);
    if (fresh.length === 0 && positive.length > 0) continue;
    const status = resolutionStatus(combined.size, false);
    for (const variant of fresh) {
      const supplyArea = areaFromCents(variant.supplyCents);
      statements.push({
        sql: `INSERT INTO apt_canonical_unit_types (
                unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(unit_type_id) DO NOTHING`,
        args: [
          canonicalUnitTypeId(complexId, exCents, variant.supplyCents),
          complexId,
          areaFromCents(exCents),
          exCents,
          supplyArea,
          variant.supplyCents,
          canonicalSupplyPyeong(supplyArea),
          supplyPyeongDisplayLabel(supplyArea),
          null,
          variant.householdCount,
          "BldRgstHubService",
          `${pnu}:${exCents}:${variant.supplyCents}`,
          "",
          "building_registry_expos",
          status,
          variant.formula,
          JSON.stringify({
            formula: variant.formula,
            residential_common_area: variant.residentialCommonArea,
            household_count: variant.householdCount,
          }),
          now,
          now,
        ],
      });
      prev.set(variant.supplyCents, status);
      if (positive.length === 0) stats.supplyFills += 1;
      else stats.variants += 1;
      stats.newTypes += 1;
    }
    if (combined.size > 1 && positive.length > 0) {
      statements.push({
        sql: `UPDATE apt_canonical_unit_types
              SET status = 'AMBIGUOUS_MULTI', updated_at = ?
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents >= 0`,
        args: [now, complexId, exCents],
      });
    }
    if (prev.has(NO_SUPPLY_CENTS) && combined.size > 0) {
      statements.push({
        sql: `DELETE FROM apt_canonical_unit_types
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents = ? AND status = 'NO_SOURCE'`,
        args: [complexId, exCents, NO_SUPPLY_CENTS],
      });
      prev.delete(NO_SUPPLY_CENTS);
    }
    existing.set(exCents, prev);
    statements.push({
      sql: `INSERT INTO apt_unit_exclusive_pairs (
              complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
              latest_trade_date, resolution_status, supply_variant_count, observed_from
            ) VALUES (?, ?, ?, 0, 0, 0, '', ?, ?, 'official_expos')
            ON CONFLICT(complex_id, exclusive_cents) DO UPDATE SET
              resolution_status = excluded.resolution_status,
              supply_variant_count = excluded.supply_variant_count`,
      args: [complexId, exCents, areaFromCents(exCents), status, combined.size],
    });
  }
  if (statements.length > 0) await batchWrite(db, statements);
}

async function writeCache(
  db: Client,
  complexId: string,
  pnu: string,
  derived: ReturnType<typeof deriveOfficialSupplies>,
  now: string,
) {
  const statements = derived.units.map((unit) => ({
    sql: `INSERT INTO official_unit_area_cache (
            complex_id, source_unit_id, source_provider, source_dataset, pnu, source_building_id,
            dong, floor, ho, exclusive_area, residential_common_area, other_common_area,
            explicit_supply_area, contract_area, source_key, source_as_of, fetched_at, provenance_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, source_unit_id) DO NOTHING`,
    args: [
      complexId,
      `${unit.dong}|${unit.ho}`,
      "BldRgstHubService",
      "getBrExposPubuseAreaInfo",
      pnu,
      unit.sourceBuildingId,
      unit.dong,
      unit.floor,
      unit.ho,
      unit.exclusiveArea,
      unit.residentialCommonArea,
      unit.otherCommonArea,
      unit.explicitSupplyArea,
      unit.contractArea,
      `${pnu}:${unit.dong}:${unit.ho}`,
      unit.sourceAsOf,
      now,
      JSON.stringify({ derivable: unit.derivable, partial: unit.partial, formula: "exclusive_plus_residential_common" }),
    ] as InArgs,
  }));
  stats.cacheRows += statements.length;
  if (statements.length > 0) await batchWrite(db, statements);
}

async function saveCheckpoint(db: Client, complexId: string, status: CheckpointStatus, pageCursor: number, total: number, detail: string) {
  await db.execute({
    sql: `INSERT INTO official_unit_area_checkpoint
            (complex_id, status, page_cursor, total_count, detail, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            status = excluded.status,
            page_cursor = excluded.page_cursor,
            total_count = excluded.total_count,
            detail = excluded.detail,
            updated_at = excluded.updated_at`,
    args: [complexId, status, pageCursor, total, detail.slice(0, 240), new Date().toISOString()],
  });
  if (status === "COMPLETE_DATA") stats.completeData += 1;
  if (status === "COMPLETE_NO_DATA") stats.completeNoData += 1;
  if (status === "IDENTITY_UNRESOLVED") stats.identityUnresolved += 1;
  if (status === "API_FAILED") stats.apiFailed += 1;
  if (status === "RATE_LIMIT_HOLD") stats.rateHold += 1;
}

async function processComplex(
  db: Client,
  row: ManifestRow,
  parcel: { platGbCd: string; bun: string; ji: string },
  existing: Map<string, Existing>,
) {
  const now = new Date().toISOString();
  const pnu = parcelPnu(row.lawdCd, row.bjdongCd, parcel.platGbCd, parcel.bun, parcel.ji);
  stats.attempted += 1;
  try {
    const fetched = await fetchAll(row.complexId, {
      sigunguCd: row.lawdCd,
      bjdongCd: row.bjdongCd,
      platGbCd: parcel.platGbCd,
      bun: parcel.bun,
      ji: parcel.ji,
    });
    const derived = deriveOfficialSupplies(fetched.rows, row.aptName);
    if (derived.units.length === 0) {
      const status: CheckpointStatus = derived.rejectedNameRows > 0 && derived.matchedRows === 0 ? "IDENTITY_UNRESOLVED" : "COMPLETE_NO_DATA";
      await saveCheckpoint(db, row.complexId, status, fetched.pages, fetched.total, status);
      rmSync(`${PARTIAL}/${row.complexId}`, { recursive: true, force: true });
      return { derived, pnu, status };
    }
    await writeCache(db, row.complexId, pnu, derived, now);
    const bucket = existing.get(row.complexId) ?? new Map();
    existing.set(row.complexId, bucket);
    if (derived.distinguishable) await applySupplies(db, row.complexId, pnu, derived.supplies, bucket, now);
    const detail = derived.distinguishable
      ? `supplies=${derived.supplies.length}`
      : `SEMANTICS_UNCLEAR ratio=${derived.residentialCommonRatio.toFixed(3)}`;
    await saveCheckpoint(db, row.complexId, "COMPLETE_DATA", fetched.pages, fetched.total, detail);
    rmSync(`${PARTIAL}/${row.complexId}`, { recursive: true, force: true });
    return { derived, pnu, status: "COMPLETE_DATA" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    if (message === "QUOTA") {
      hardStop = "QUOTA";
      await saveCheckpoint(db, row.complexId, "RATE_LIMIT_HOLD", 0, 0, "quota");
      throw error;
    }
    if (message === "RATE_LIMIT_HOLD") {
      await saveCheckpoint(db, row.complexId, "RATE_LIMIT_HOLD", 0, 0, "429");
      throw error;
    }
    await saveCheckpoint(db, row.complexId, "API_FAILED", 0, 0, message);
    return null;
  }
}

async function coverage(db: Client) {
  const rows = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_complex_master) AS complexes,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents >= 0) AS supply_complexes,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs) AS pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'EXACT_SINGLE') AS exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'AMBIGUOUS_MULTI') AS ambiguous_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'NO_SOURCE') AS no_source_pairs,
      (SELECT COUNT(*) FROM apt_canonical_unit_types) AS types,
      (SELECT SUM(CASE WHEN resolution_status = 'EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) FROM apt_unit_exclusive_pairs) AS exact12,
      (SELECT SUM(trade_count_12m) FROM apt_unit_exclusive_pairs) AS att12,
      (SELECT SUM(CASE WHEN resolution_status = 'EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) FROM apt_unit_exclusive_pairs) AS exact3y,
      (SELECT SUM(trade_count_3y) FROM apt_unit_exclusive_pairs) AS att3y
  `);
  return rows.rows[0];
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  mkdirSync(PARTIAL, { recursive: true });
  const migration = readFileSync(MIGRATION, "utf8");
  const precheck = precheckAdditiveCreateSql(migration);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);

  const done = new Set<string>();
  const prior = await db.execute(`SELECT complex_id, status FROM official_unit_area_checkpoint`);
  for (const row of prior.rows) {
    const status = str(row.status);
    if (status === "COMPLETE_DATA" || status === "COMPLETE_NO_DATA" || status === "IDENTITY_UNRESOLVED") {
      done.add(str(row.complex_id));
    }
  }

  const existing = new Map<string, Existing>();
  const current = await db.execute(`SELECT complex_id, exclusive_cents, supply_cents, status FROM apt_canonical_unit_types`);
  for (const row of current.rows) {
    const complexId = str(row.complex_id);
    const ex = num(row.exclusive_cents);
    const su = num(row.supply_cents);
    let bucket = existing.get(complexId);
    if (!bucket) {
      bucket = new Map();
      existing.set(complexId, bucket);
    }
    let supplies = bucket.get(ex);
    if (!supplies) {
      supplies = new Map();
      bucket.set(ex, supplies);
    }
    supplies.set(su, str(row.status));
  }

  const pilots = await db.execute(`
    SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun
    FROM apt_complex_master
    WHERE apt_name_norm IN (
      '잠실엘스','파크리오','리센츠','헬리오시티','반포자이','래미안퍼스티지','은마','도곡렉슬','마포프레스티지자이','포레나노원'
    )
    ORDER BY lawd_cd, apt_name_norm
  `);
  const pilotOrder = ["잠실엘스", "파크리오", "리센츠", "헬리오시티", "반포자이", "래미안퍼스티지", "은마", "도곡렉슬", "마포프레스티지자이", "포레나노원"];
  const pilotRows = [...pilots.rows].sort((a, b) => {
    const ai = pilotOrder.indexOf(str(a.apt_name));
    const bi = pilotOrder.indexOf(str(b.apt_name));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || str(a.lawd_cd).localeCompare(str(b.lawd_cd));
  });
  const pilotNotes: Record<string, unknown> = {};
  for (const row of pilotRows) {
    const item: ManifestRow = {
      complexId: str(row.complex_id),
      aptName: str(row.apt_name),
      lawdCd: str(row.lawd_cd),
      bjdongCd: str(row.bjdong_cd),
      jibun: str(row.jibun),
      recent: 1,
    };
    console.log(`pilot ${item.aptName} ${item.complexId} ${item.lawdCd}`);
    if (done.has(item.complexId)) continue;
    const parcel = parseParcelJibun(item.jibun);
    if (!parcel || !item.bjdongCd) {
      await saveCheckpoint(db, item.complexId, "IDENTITY_UNRESOLVED", 0, 0, "no parcel");
      pilotNotes[item.complexId] = { name: item.aptName, status: "IDENTITY_UNRESOLVED" };
      continue;
    }
    const result = await processComplex(db, item, parcel, existing);
    pilotNotes[item.complexId] = {
      name: item.aptName,
      lawdCd: item.lawdCd,
      status: result?.status ?? "API_FAILED",
      distinguishable: result?.derived.distinguishable ?? false,
      ratio: result?.derived.residentialCommonRatio ?? null,
      supplies: result?.derived.supplies.map((supply) => [supply.exclusiveCents, supply.supplyCents]) ?? [],
    };
    done.add(item.complexId);
    if (item.complexId === "cx_4c63d9a100973c60") {
      const got = new Set((result?.derived.supplies ?? []).map((supply) => `${supply.exclusiveCents}:${supply.supplyCents}`));
      for (const [ex, su] of JAMSIL_REQUIRED) {
        if (!got.has(`${ex}:${su}`)) throw new Error(`jamsil semantic gate failed ${ex}->${su}`);
      }
      console.log("jamsil semantic gate PASS");
    }
  }

  const kapt = await db.execute(`
    SELECT l.complex_id, l.source_meta_json
    FROM apt_complex_source_links l
    JOIN apt_unit_acquisition_manifest m ON m.complex_id = l.complex_id
    WHERE l.source = 'KAPT' AND m.jibun = ''
  `);
  const kaptJibun = new Map<string, string>();
  for (const row of kapt.rows) {
    try {
      const meta = JSON.parse(str(row.source_meta_json)) as { jibun?: string };
      if (meta.jibun) kaptJibun.set(str(row.complex_id), meta.jibun);
    } catch {
      // ignore malformed source meta
    }
  }

  const manifest = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.lawd_cd, m.bjdong_cd, m.jibun, COALESCE(t.c12, 0) AS c12
    FROM apt_unit_acquisition_manifest m
    LEFT JOIN (
      SELECT complex_id, SUM(trade_count_12m) AS c12
      FROM apt_unit_exclusive_pairs
      GROUP BY complex_id
    ) t ON t.complex_id = m.complex_id
  `);
  const queue: ManifestRow[] = [];
  for (const row of manifest.rows) {
    const complexId = str(row.complex_id);
    if (done.has(complexId)) continue;
    queue.push({
      complexId,
      aptName: str(row.apt_name),
      lawdCd: str(row.lawd_cd),
      bjdongCd: str(row.bjdong_cd),
      jibun: str(row.jibun) || kaptJibun.get(complexId) || "",
      recent: num(row.c12),
    });
  }
  queue.sort((a, b) => priorityRank(a.lawdCd, a.recent) - priorityRank(b.lawdCd, b.recent) || a.complexId.localeCompare(b.complexId));
  console.log(`queue ${queue.length} pilots_done ${Object.keys(pilotNotes).length}`);

  let cursor = 0;
  for (const row of queue) {
    if (hardStop) break;
    cursor += 1;
    const parcel = parseParcelJibun(row.jibun);
    if (!parcel || !row.bjdongCd) {
      await saveCheckpoint(db, row.complexId, "IDENTITY_UNRESOLVED", 0, 0, "no parcel");
    } else {
      try {
        await processComplex(db, row, parcel, existing);
      } catch (error) {
        const message = error instanceof Error ? error.message : "error";
        if (message === "QUOTA" || message === "RATE_LIMIT_HOLD") break;
        throw error;
      }
    }
    if (cursor % 25 === 0) {
      console.log(JSON.stringify({ cursor, queue: queue.length, ...stats, hardStop }));
    }
  }

  const cov = await coverage(db);
  const report = { stats, hardStop, remaining: queue.length - cursor, coverage: cov, pilots: pilotNotes };
  writeFileSync("/tmp/official-supply-report.json", JSON.stringify(report));
  console.log(JSON.stringify({ stats, hardStop, remaining: Math.max(0, queue.length - cursor), coverage: cov }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
