/**
 * Incremental national supply updater.
 *
 * identity — recover 19-digit PNUs already stored internally. No address prose.
 * api      — official expos API for BULK_JOIN_MISS only. Reuses successful calls.
 * coverage — recompute pair and trade-weighted coverage. Does not rebuild price position.
 *
 * Same bulk month + checksum rerun is idempotent: completed API checkpoints are skipped.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/incremental-supply-update.mts [identity|api|coverage|all]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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
  type DerivedSupply,
  type ExposRow,
} from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";
import {
  classifyInternalPnus,
  classifySupplyConflict,
  sameIncrementalSource,
  type SupplyConflictClass,
} from "../../src/lib/unit-type/supply-residual";

const MIGRATION = "src/lib/db/migrations/20260926_supply_incremental_state.sql";
const FOLLOWUP = "/tmp/building-hub-bulk/external-evidence/remaining-complexes-followup.jsonl";
const SOURCE_META = "/tmp/building-hub-bulk/source-meta.json";
const REPORT = "/tmp/building-hub-bulk/external-evidence/residual-cleanup-report.json";
const API_STATS = "/tmp/building-hub-bulk/external-evidence/residual-api-stats.json";
const PARTIAL = "/tmp/official-unit-area/residual";
const PAGE_SIZE = 100;
const BATCH = 40;
const MAX_ATTEMPTS = 3;
const BULK_MONTH = "2026-08";
const SOURCE_VERSION = "bldrgst-hub-bulk-2026-08";

type Followup = { complex_id: string; class: string };
type Existing = Map<number, Map<number, string>>;

const apiStats = {
  calls: 0,
  reused: 0,
  retries: 0,
  http429: 0,
  failures: 0,
  recovered: 0,
  officialNoData: 0,
  identityConflict: 0,
  apiFailed: 0,
  inserts: 0,
  updates: 0,
  positiveOverwrites: 0,
  complexesChanged: 0,
  noSourceExact: 0,
  noSourceAmbiguous: 0,
  ambiguousResolved: 0,
};

let spacingMs = 200;
let nextSlot = 0;
let hardStop = "";

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function loadFollowup(): Followup[] {
  return readFileSync(FOLLOWUP, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Followup);
}

function bulkSha(): string {
  if (!existsSync(SOURCE_META)) return "";
  const meta = JSON.parse(readFileSync(SOURCE_META, "utf8")) as { sha256?: string; source_month?: string };
  return str(meta.sha256);
}

async function openDb(): Promise<Client> {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const precheck = precheckAdditiveCreateSql(readFileSync(MIGRATION, "utf8"));
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);
  return db;
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]) {
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH), "write");
  }
}

async function identityPhase(db: Client) {
  const rows = loadFollowup().filter((row) => row.class === "MISSING_JIBUN_BUT_PNU_AVAILABLE");
  const counts = { recovered: 0, stillMissing: 0, conflict: 0 };
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const ids = chunk.map((row) => row.complex_id);
    const ph = ids.map(() => "?").join(",");
    const masters = await db.execute({
      sql: `SELECT complex_id, lawd_cd, bjdong_cd FROM apt_complex_master WHERE complex_id IN (${ph})`,
      args: ids,
    });
    const masterById = new Map(masters.rows.map((row) => [str(row.complex_id), row]));
    const cache = await db.execute({
      sql: `SELECT complex_id, pnu FROM official_unit_area_cache WHERE complex_id IN (${ph}) GROUP BY complex_id, pnu`,
      args: ids,
    });
    const checkpoints = await db.execute({
      sql: `SELECT complex_id, pnu FROM complex_building_checkpoint WHERE complex_id IN (${ph})`,
      args: ids,
    });
    const pnus = new Map<string, { values: string[]; sources: Set<string> }>();
    const add = (complexId: string, pnu: string, source: string) => {
      if (!/^\d{19}$/.test(pnu)) return;
      const slot = pnus.get(complexId) ?? { values: [], sources: new Set<string>() };
      slot.values.push(pnu);
      slot.sources.add(source);
      pnus.set(complexId, slot);
    };
    for (const row of cache.rows) add(str(row.complex_id), str(row.pnu), "official_unit_area_cache");
    for (const row of checkpoints.rows) add(str(row.complex_id), str(row.pnu), "complex_building_checkpoint");
    const statements: { sql: string; args: InArgs }[] = [];
    for (const row of chunk) {
      const master = masterById.get(row.complex_id);
      const found = pnus.get(row.complex_id);
      const verdict = classifyInternalPnus(found?.values ?? [], str(master?.lawd_cd), str(master?.bjdong_cd));
      if (verdict.status === "IDENTITY_RECOVERED") counts.recovered += 1;
      else if (verdict.status === "IDENTITY_CONFLICT") counts.conflict += 1;
      else counts.stillMissing += 1;
      statements.push({
        sql: `INSERT INTO apt_supply_identity_residual (
                complex_id, prior_class, status, pnu, identity_source, lawd_cd, bjdong_cd,
                plat_gb_cd, bun, ji, api_class, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
              ON CONFLICT(complex_id) DO UPDATE SET
                prior_class = excluded.prior_class,
                status = excluded.status,
                pnu = excluded.pnu,
                identity_source = excluded.identity_source,
                lawd_cd = excluded.lawd_cd,
                bjdong_cd = excluded.bjdong_cd,
                plat_gb_cd = excluded.plat_gb_cd,
                bun = excluded.bun,
                ji = excluded.ji,
                updated_at = excluded.updated_at`,
        args: [
          row.complex_id,
          row.class,
          verdict.status,
          verdict.pnu,
          found ? [...found.sources].sort().join("+") : "",
          verdict.parcel?.lawdCd ?? "",
          verdict.parcel?.bjdongCd ?? "",
          verdict.parcel?.platGbCd ?? "",
          verdict.parcel?.bun ?? "",
          verdict.parcel?.ji ?? "",
          now,
        ],
      });
    }
    await batchWrite(db, statements);
    if (i % 2000 === 0) console.log(JSON.stringify({ identity: i, ...counts }));
  }

  const bulk = loadFollowup().filter((row) => row.class === "BULK_JOIN_MISS").map((row) => row.complex_id);
  for (let i = 0; i < bulk.length; i += 200) {
    const ids = bulk.slice(i, i + 200);
    const ph = ids.map(() => "?").join(",");
    const manifest = await db.execute({
      sql: `SELECT complex_id, lawd_cd, bjdong_cd, jibun FROM apt_unit_acquisition_manifest WHERE complex_id IN (${ph})`,
      args: ids,
    });
    const statements: { sql: string; args: InArgs }[] = [];
    for (const row of manifest.rows) {
      const parcel = parseParcelJibun(str(row.jibun));
      const lawd = str(row.lawd_cd);
      const bjdong = str(row.bjdong_cd);
      const ok = parcel && lawd && bjdong;
      const pnu = ok ? parcelPnu(lawd, bjdong, parcel.platGbCd, parcel.bun, parcel.ji) : "";
      statements.push({
        sql: `INSERT INTO apt_supply_identity_residual (
                complex_id, prior_class, status, pnu, identity_source, lawd_cd, bjdong_cd,
                plat_gb_cd, bun, ji, api_class, updated_at
              ) VALUES (?, 'BULK_JOIN_MISS', ?, ?, 'acquisition_manifest', ?, ?, ?, ?, ?, '', ?)
              ON CONFLICT(complex_id) DO UPDATE SET
                prior_class = 'BULK_JOIN_MISS',
                status = excluded.status,
                pnu = excluded.pnu,
                identity_source = excluded.identity_source,
                lawd_cd = excluded.lawd_cd,
                bjdong_cd = excluded.bjdong_cd,
                plat_gb_cd = excluded.plat_gb_cd,
                bun = excluded.bun,
                ji = excluded.ji,
                updated_at = excluded.updated_at`,
        args: [
          str(row.complex_id),
          ok ? "IDENTITY_RECOVERED" : "IDENTITY_CONFLICT",
          pnu,
          lawd,
          bjdong,
          parcel?.platGbCd ?? "",
          parcel?.bun ?? "",
          parcel?.ji ?? "",
          now,
        ],
      });
    }
    await batchWrite(db, statements);
  }
  console.log(JSON.stringify({ identityDone: rows.length, ...counts, bulkParcels: bulk.length }));
  return counts;
}

async function conflictPhase(db: Client) {
  const total = num((await db.execute(`SELECT COUNT(*) n FROM apt_unit_supply_conflicts`)).rows[0]?.n);
  const classes: Record<SupplyConflictClass, number> = {
    PRECISION_ONLY: 0,
    REAL_VARIANT: 0,
    OLDER_SOURCE: 0,
    IDENTITY_CONFLICT: 0,
    DERIVATION_CONFLICT: 0,
    UNKNOWN: 0,
  };
  const now = new Date().toISOString();
  let offset = 0;
  while (offset < total) {
    const rows = await db.execute({
      sql: `SELECT conflict_id, exclusive_cents, held_supply_cents, reason, provenance_json
            FROM apt_unit_supply_conflicts ORDER BY conflict_id LIMIT 400 OFFSET ?`,
      args: [offset],
    });
    if (!rows.rows.length) break;
    const statements = rows.rows.map((row) => {
      const klass = classifySupplyConflict({
        exclusiveCents: num(row.exclusive_cents),
        heldSupplyCents: num(row.held_supply_cents),
        reason: str(row.reason),
        provenanceJson: str(row.provenance_json),
      });
      classes[klass] += 1;
      return {
        sql: `INSERT INTO apt_supply_conflict_class (conflict_id, class, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(conflict_id) DO UPDATE SET class = excluded.class, updated_at = excluded.updated_at`,
        args: [str(row.conflict_id), klass, now] as InArgs,
      };
    });
    await batchWrite(db, statements);
    offset += rows.rows.length;
    if (offset % 2000 === 0) console.log(JSON.stringify({ conflicts: offset, classes }));
  }
  const review =
    classes.REAL_VARIANT + classes.IDENTITY_CONFLICT + classes.DERIVATION_CONFLICT + classes.UNKNOWN;
  console.log(JSON.stringify({ conflictDone: total, classes, review }));
  return { total, classes, review };
}

async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + spacingMs;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function fetchPage(
  parcel: { sigunguCd: string; bjdongCd: string; platGbCd: string; bun: string; ji: string },
  page: number,
) {
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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await pace();
    apiStats.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(
        `https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?serviceKey=${encodeURIComponent(key)}&${qs}`,
        { headers: { "User-Agent": "ziplab-supply" }, signal: controller.signal },
      );
      const text = await res.text();
      if (res.status === 429) {
        apiStats.http429 += 1;
        apiStats.retries += 1;
        spacingMs = Math.min(4000, Math.round(spacingMs * 1.8));
        last = "429";
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        apiStats.retries += 1;
        last = `HTTP ${res.status}`;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      let parsed: {
        response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { totalCount?: unknown; items?: { item?: unknown } } };
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        apiStats.retries += 1;
        last = "non-json";
        continue;
      }
      const code = str(parsed.response?.header?.resultCode);
      const msg = str(parsed.response?.header?.resultMsg);
      if (msg.includes("한도") || msg.includes("LIMIT") || msg.includes("트래픽") || code === "22") {
        hardStop = "QUOTA";
        throw new Error("QUOTA");
      }
      if (code && code !== "00" && code !== "0" && code !== "000" && code !== "03") {
        apiStats.retries += 1;
        last = `API ${code}`;
        continue;
      }
      const total = num(parsed.response?.body?.totalCount);
      const raw = parsed.response?.body?.items?.item;
      const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as ExposRow[];
      return { total, items };
    } catch (error) {
      if (error instanceof Error && error.message === "QUOTA") throw error;
      apiStats.retries += 1;
      last = error instanceof Error && error.name === "AbortError" ? "timeout" : last;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(last);
}

async function fetchAll(
  complexId: string,
  parcel: { sigunguCd: string; bjdongCd: string; platGbCd: string; bun: string; ji: string },
) {
  const dir = `${PARTIAL}/${complexId}`;
  mkdirSync(dir, { recursive: true });
  const rows: ExposRow[] = [];
  let total = 0;
  let highest = 0;
  if (existsSync(`${dir}/total.txt`)) total = Number(readFileSync(`${dir}/total.txt`, "utf8"));
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const match = /^p(\d+)\.json$/.exec(name);
      if (!match) continue;
      const pageNo = Number(match[1]);
      highest = Math.max(highest, pageNo);
      rows.push(...(JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as ExposRow[]));
    }
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
    for (let i = 0; i < 4 && nextPage + i <= pages; i += 1) chunk.push(nextPage + i);
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

async function applySupplies(
  db: Client,
  complexId: string,
  pnu: string,
  supplies: DerivedSupply[],
  existing: Existing,
  now: string,
) {
  const statements: { sql: string; args: InArgs }[] = [];
  const byExclusive = new Map<number, DerivedSupply[]>();
  for (const supply of supplies) {
    const list = byExclusive.get(supply.exclusiveCents) ?? [];
    list.push(supply);
    byExclusive.set(supply.exclusiveCents, list);
  }
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
            recovery: "incremental_api",
          }),
          now,
          now,
        ],
      });
      prev.set(variant.supplyCents, status);
      apiStats.inserts += 1;
    }
    if (combined.size > 1 && positive.length > 0) {
      statements.push({
        sql: `UPDATE apt_canonical_unit_types
              SET status = 'AMBIGUOUS_MULTI', updated_at = ?
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents >= 0
                AND status != 'AMBIGUOUS_MULTI'`,
        args: [now, complexId, exCents],
      });
      apiStats.updates += 1;
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
    apiStats.updates += 1;
  }
  if (statements.length > 0) await batchWrite(db, statements);
}

async function writeCache(db: Client, complexId: string, pnu: string, rows: ExposRow[], aptName: string, now: string) {
  const derived = deriveOfficialSupplies(rows, aptName);
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
      JSON.stringify({ derivable: unit.derivable, partial: unit.partial, recovery: "incremental_api" }),
    ] as InArgs,
  }));
  if (statements.length > 0) await batchWrite(db, statements);
  return derived;
}

async function markApi(db: Client, complexId: string, apiClass: string, detail: string, total = 0) {
  const now = new Date().toISOString();
  if (!apiClass) {
    await db.execute({
      sql: `INSERT INTO official_unit_area_checkpoint
              (complex_id, status, page_cursor, total_count, detail, updated_at)
            VALUES (?, 'RATE_LIMIT_HOLD', 0, ?, ?, ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              status = 'RATE_LIMIT_HOLD',
              detail = excluded.detail,
              updated_at = excluded.updated_at`,
      args: [complexId, total, detail.slice(0, 240), now],
    });
    return;
  }
  const checkpoint =
    apiClass === "RECOVERED_DATA"
      ? "COMPLETE_DATA"
      : apiClass === "IDENTITY_CONFLICT"
        ? "IDENTITY_UNRESOLVED"
        : apiClass === "API_FAILED"
          ? "API_FAILED"
          : "COMPLETE_NO_DATA";
  await db.execute({
    sql: `INSERT INTO official_unit_area_checkpoint
            (complex_id, status, page_cursor, total_count, detail, updated_at)
          VALUES (?, ?, 0, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            status = excluded.status,
            total_count = excluded.total_count,
            detail = excluded.detail,
            updated_at = excluded.updated_at`,
    args: [complexId, checkpoint, total, detail.slice(0, 240), now],
  });
  await db.execute({
    sql: `UPDATE apt_supply_identity_residual SET api_class = ?, updated_at = ? WHERE complex_id = ?`,
    args: [apiClass, now, complexId],
  });
}

async function apiPhase(db: Client) {
  mkdirSync(PARTIAL, { recursive: true });
  const state = await db.execute(`SELECT last_bulk_source_month, bulk_sha256, pending_api_residuals FROM apt_supply_incremental_state WHERE id = 1`);
  const previous = state.rows[0]
    ? { month: str(state.rows[0].last_bulk_source_month), sha256: str(state.rows[0].bulk_sha256) }
    : null;
  const sha = bulkSha();
  const same = sameIncrementalSource(previous, { month: BULK_MONTH, sha256: sha });
  const pending = num(state.rows[0]?.pending_api_residuals);
  if (same && pending === 0 && previous) {
    console.log(JSON.stringify({ api: "idempotent-skip", month: BULK_MONTH }));
    return;
  }
  const targets = await db.execute(`
    SELECT complex_id, lawd_cd, bjdong_cd, plat_gb_cd, bun, ji, pnu
    FROM apt_supply_identity_residual
    WHERE prior_class = 'BULK_JOIN_MISS'
      AND status = 'IDENTITY_RECOVERED'
      AND api_class = ''
  `);
  const ids = targets.rows.map((row) => str(row.complex_id));
  const doneDetail = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT complex_id, detail FROM official_unit_area_checkpoint WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rows.rows) doneDetail.set(str(row.complex_id), str(row.detail));
  }
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT complex_id, apt_name FROM apt_complex_master WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rows.rows) names.set(str(row.complex_id), str(row.apt_name));
  }
  const before = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const ph = chunk.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, resolution_status FROM apt_unit_exclusive_pairs WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rows.rows) before.set(`${row.complex_id}|${row.exclusive_cents}`, str(row.resolution_status));
  }
  const existing = new Map<string, Existing>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const ph = chunk.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_cents, status FROM apt_canonical_unit_types WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rows.rows) {
      const complexId = str(row.complex_id);
      const bucket = existing.get(complexId) ?? new Map<number, Map<number, string>>();
      const supplies = bucket.get(num(row.exclusive_cents)) ?? new Map<number, string>();
      supplies.set(num(row.supply_cents), str(row.status));
      bucket.set(num(row.exclusive_cents), supplies);
      existing.set(complexId, bucket);
    }
  }

  let cursor = 0;
  for (const row of targets.rows) {
    if (hardStop) break;
    const complexId = str(row.complex_id);
    cursor += 1;
    if (str(doneDetail.get(complexId)).startsWith("API ")) {
      apiStats.reused += 1;
      continue;
    }
    const parcel = {
      sigunguCd: str(row.lawd_cd),
      bjdongCd: str(row.bjdong_cd),
      platGbCd: str(row.plat_gb_cd),
      bun: str(row.bun),
      ji: str(row.ji),
    };
    const now = new Date().toISOString();
    try {
      const fetched = await fetchAll(complexId, parcel);
      const derived = await writeCache(db, complexId, str(row.pnu), fetched.rows, names.get(complexId) || "", now);
      let apiClass = "OFFICIAL_NO_DATA";
      if (derived.units.length === 0 && derived.rejectedNameRows > 0 && derived.matchedRows === 0) {
        apiClass = "IDENTITY_CONFLICT";
      } else if (derived.distinguishable && derived.supplies.length > 0) {
        const bucket = existing.get(complexId) ?? new Map();
        existing.set(complexId, bucket);
        await applySupplies(db, complexId, str(row.pnu), derived.supplies, bucket, now);
        apiClass = "RECOVERED_DATA";
        apiStats.complexesChanged += 1;
      }
      if (apiClass === "RECOVERED_DATA") apiStats.recovered += 1;
      else if (apiClass === "IDENTITY_CONFLICT") apiStats.identityConflict += 1;
      else apiStats.officialNoData += 1;
      await markApi(db, complexId, apiClass, `API ${apiClass} ratio=${derived.residentialCommonRatio.toFixed(3)} supplies=${derived.supplies.length}`, fetched.total);
      rmSync(`${PARTIAL}/${complexId}`, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      if (message === "QUOTA") {
        hardStop = "QUOTA";
        await markApi(db, complexId, "", "API RATE_LIMIT_HOLD");
        await db.execute({
          sql: `UPDATE apt_supply_identity_residual SET api_class = '', updated_at = ? WHERE complex_id = ?`,
          args: [new Date().toISOString(), complexId],
        });
        break;
      }
      apiStats.failures += 1;
      apiStats.apiFailed += 1;
      const klass = message === "429" ? "" : "API_FAILED";
      if (message === "429") {
        hardStop = "RATE_LIMIT";
        await markApi(db, complexId, "", "API RATE_LIMIT_HOLD");
        break;
      }
      await markApi(db, complexId, klass || "API_FAILED", `API API_FAILED ${message}`);
    }
    if (cursor % 10 === 0) console.log(JSON.stringify({ cursor, targets: targets.rows.length, ...apiStats, hardStop }));
  }

  const afterIds = ids;
  for (let i = 0; i < afterIds.length; i += 100) {
    const chunk = afterIds.slice(i, i + 100);
    if (!chunk.length) continue;
    const ph = chunk.map(() => "?").join(",");
    const rows = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, resolution_status FROM apt_unit_exclusive_pairs WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rows.rows) {
      const key = `${row.complex_id}|${row.exclusive_cents}`;
      const prev = before.get(key);
      const next = str(row.resolution_status);
      if (prev === "NO_SOURCE" && next === "EXACT_SINGLE") apiStats.noSourceExact += 1;
      if (prev === "NO_SOURCE" && next === "AMBIGUOUS_MULTI") apiStats.noSourceAmbiguous += 1;
      if (prev === "AMBIGUOUS_MULTI" && next === "EXACT_SINGLE") apiStats.ambiguousResolved += 1;
    }
  }
  writeFileSync(API_STATS, JSON.stringify({ ...apiStats, hardStop, cursor, targets: targets.rows.length }, null, 2));
  console.log(JSON.stringify({ apiDone: true, ...apiStats, hardStop, cursor, targets: targets.rows.length }));
}

async function coveragePhase(db: Client) {
  const national = (await db.execute(`
    SELECT
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents >= 0) supply_complexes,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='AMBIGUOUS_MULTI') ambiguous_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='NO_SOURCE') no_source_pairs,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_complexes,
      (SELECT SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) FROM apt_unit_exclusive_pairs) exact12,
      (SELECT SUM(trade_count_12m) FROM apt_unit_exclusive_pairs) att12,
      (SELECT SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) FROM apt_unit_exclusive_pairs) exact3y,
      (SELECT SUM(trade_count_3y) FROM apt_unit_exclusive_pairs) att3y
  `)).rows[0];
  const regionSql = `
    SELECT CASE
             WHEN m.sido LIKE '서울%' THEN 'SEOUL'
             WHEN m.sido LIKE '경기%' THEN 'GYEONGGI'
             WHEN m.sido LIKE '인천%' THEN 'INCHEON'
             WHEN m.sido LIKE '부산%' THEN 'BUSAN'
             WHEN m.sido LIKE '대구%' THEN 'DAEGU'
             WHEN m.sido LIKE '대전%' THEN 'DAEJEON'
             WHEN m.sido LIKE '광주%' THEN 'GWANGJU'
             WHEN m.sido LIKE '울산%' THEN 'ULSAN'
             ELSE 'OTHER'
           END AS region,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) exact_pairs,
           SUM(CASE WHEN p.resolution_status='AMBIGUOUS_MULTI' THEN 1 ELSE 0 END) ambiguous_pairs,
           SUM(CASE WHEN p.resolution_status='NO_SOURCE' THEN 1 ELSE 0 END) no_source_pairs,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_12m ELSE 0 END) exact12,
           SUM(p.trade_count_12m) att12,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_3y ELSE 0 END) exact3y,
           SUM(p.trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id = p.complex_id
    GROUP BY 1
  `;
  const supplyRegionSql = `
    SELECT CASE
             WHEN m.sido LIKE '서울%' THEN 'SEOUL'
             WHEN m.sido LIKE '경기%' THEN 'GYEONGGI'
             WHEN m.sido LIKE '인천%' THEN 'INCHEON'
             WHEN m.sido LIKE '부산%' THEN 'BUSAN'
             WHEN m.sido LIKE '대구%' THEN 'DAEGU'
             WHEN m.sido LIKE '대전%' THEN 'DAEJEON'
             WHEN m.sido LIKE '광주%' THEN 'GWANGJU'
             WHEN m.sido LIKE '울산%' THEN 'ULSAN'
             ELSE 'OTHER'
           END AS region,
           COUNT(DISTINCT u.complex_id) supply_complexes
    FROM apt_canonical_unit_types u
    JOIN apt_complex_master m ON m.complex_id = u.complex_id
    WHERE u.supply_cents >= 0
    GROUP BY 1
  `;
  const pairRegions = (await db.execute(regionSql)).rows;
  const supplyRegions = (await db.execute(supplyRegionSql)).rows;
  const supplyByRegion = new Map(supplyRegions.map((row) => [str(row.region), num(row.supply_complexes)]));
  const regions = pairRegions.map((row) => ({ ...row, supply_complexes: supplyByRegion.get(str(row.region)) ?? 0 }));
  const fallback = num((await db.execute(`
    SELECT COUNT(*) n FROM (
      SELECT complex_id FROM apt_unit_exclusive_pairs
      GROUP BY complex_id
      HAVING SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) = 0
    )
  `)).rows[0]?.n);
  const identity = (await db.execute(`
    SELECT status, COUNT(*) n FROM apt_supply_identity_residual
    WHERE prior_class = 'MISSING_JIBUN_BUT_PNU_AVAILABLE' GROUP BY 1
  `)).rows;
  const api = (await db.execute(`
    SELECT api_class, COUNT(*) n FROM apt_supply_identity_residual
    WHERE prior_class = 'BULK_JOIN_MISS' GROUP BY 1
  `)).rows;
  const conflicts = (await db.execute(`SELECT class, COUNT(*) n FROM apt_supply_conflict_class GROUP BY 1`)).rows;
  const v2 = num((await db.execute(`SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`)).rows[0]?.n);
  const review = conflicts
    .filter((row) => ["REAL_VARIANT", "IDENTITY_CONFLICT", "DERIVATION_CONFLICT", "UNKNOWN"].includes(str(row.class)))
    .reduce((sum, row) => sum + num(row.n), 0);
  const pending = num((await db.execute(`
    SELECT COUNT(*) n FROM apt_supply_identity_residual
    WHERE prior_class = 'BULK_JOIN_MISS' AND api_class = ''
  `)).rows[0]?.n);
  const changed = existsSync(API_STATS) ? num(JSON.parse(readFileSync(API_STATS, "utf8")).complexesChanged) : 0;
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO apt_supply_incremental_state (
            id, last_bulk_source_month, last_processed_source_version, bulk_sha256,
            complexes_changed, pending_api_residuals, conflicts_requiring_review, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            last_bulk_source_month = excluded.last_bulk_source_month,
            last_processed_source_version = excluded.last_processed_source_version,
            bulk_sha256 = excluded.bulk_sha256,
            complexes_changed = excluded.complexes_changed,
            pending_api_residuals = excluded.pending_api_residuals,
            conflicts_requiring_review = excluded.conflicts_requiring_review,
            updated_at = excluded.updated_at`,
    args: [BULK_MONTH, SOURCE_VERSION, bulkSha(), changed, pending, review, now],
  });
  const report = {
    national,
    regions,
    fallbackComplexes: fallback,
    identity,
    api,
    conflicts,
    pricePositionV2Rows: v2,
    pricePositionRebuilt: false,
    apiStats: existsSync(API_STATS) ? JSON.parse(readFileSync(API_STATS, "utf8")) : null,
    pending,
    review,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ national, fallbackComplexes: fallback, identity, api, conflicts, pending, review, v2 }));
}

async function main() {
  const phase = process.argv[2] || "all";
  const db = await openDb();
  if (phase === "identity" || phase === "all") {
    await identityPhase(db);
    await conflictPhase(db);
  }
  if (phase === "api" || phase === "all") await apiPhase(db);
  if (phase === "coverage" || phase === "all") await coveragePhase(db);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
