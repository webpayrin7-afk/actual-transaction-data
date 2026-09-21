/**
 * Publish exact type↔building links from V2 area-key package.
 * Join: complex_id + exclusive_cents + supply_cents → Core unit_type_id (ut_ + 32 hex).
 * Does not use V1 16-hex ids. Does not change physical_household_count or Core types.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { loadComplexBuildingsApiLive } from "@/lib/buildings/api";
import { payloadBytes } from "@/lib/buildings/geometry";
import { upsertApiSnapshot } from "@/lib/buildings/repository";

const VERSION = "building-unit-link|buildinghub-2026-08|exact-dong-v2-core-area-key";
const FILE = process.env.EXACT_TYPE_V2
  ?? "/home/ubuntu/.cursor/projects/workspace/uploads/exact_type_building_households_v2.csv_2e1a.gz";
const APPLY = process.argv.includes("--apply");
const SOURCE = "buildinghub-2026-08.exact-dong-v2-core-area-key";

const PILOTS: Record<string, { id: string; exact: number }> = {
  "잠실엘스": { id: "cx_4c63d9a100973c60", exact: 4464 },
  "파크리오": { id: "cx_ed52bf895d064c11", exact: 6819 },
  "리센츠": { id: "cx_caf229b5ac63cfbd", exact: 1710 },
  "헬리오시티": { id: "cx_30d7eea6da810b52", exact: 8349 },
  "반포자이": { id: "cx_1c244e7305d12c44", exact: 3269 },
  "래미안퍼스티지": { id: "cx_3bcf0f87bce7496b", exact: 983 },
  "은마": { id: "cx_0320fd9e007e1f8c", exact: 0 },
  "도곡렉슬": { id: "cx_c9ed0235ecca960c", exact: 2955 },
  "마포프레스티지자이": { id: "cx_07caf64c556e85a7", exact: 1694 },
  "포레나노원": { id: "cx_88d05e29df26a0d6", exact: 1028 },
};

type InRow = {
  complexId: string;
  buildingId: string;
  exclusiveCents: number;
  supplyCents: number;
  household: number;
};

async function readRows(): Promise<InRow[]> {
  const rl = readline.createInterface({
    input: createReadStream(FILE).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  const rows: InRow[] = [];
  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;
    const p = line.split(",");
    rows.push({
      complexId: p[0],
      buildingId: p[1],
      exclusiveCents: Number(p[2]),
      supplyCents: Number(p[3]),
      household: Number(p[6]),
    });
  }
  return rows;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const rows = await readRows();
  const keySeen = new Set<string>();
  let dupKeys = 0;
  let households = 0;
  const pairs = new Set<string>();
  const exSupply = new Map<string, Set<number>>();
  for (const row of rows) {
    households += row.household;
    const key = `${row.complexId}\t${row.buildingId}\t${row.exclusiveCents}\t${row.supplyCents}`;
    if (keySeen.has(key)) dupKeys += 1;
    else keySeen.add(key);
    const pair = `${row.complexId}\t${row.exclusiveCents}\t${row.supplyCents}`;
    pairs.add(pair);
    const ex = `${row.complexId}\t${row.exclusiveCents}`;
    const set = exSupply.get(ex) ?? new Set<number>();
    set.add(row.supplyCents);
    exSupply.set(ex, set);
  }
  let multiSupply = 0;
  for (const set of exSupply.values()) if (set.size > 1) multiSupply += 1;

  const typeByPair = new Map<string, string[]>();
  let offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_cents, unit_type_id
            FROM apt_canonical_unit_types ORDER BY unit_type_id LIMIT 10000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) {
      const pair = `${r.complex_id}\t${r.exclusive_cents}\t${r.supply_cents}`;
      const list = typeByPair.get(pair) ?? [];
      list.push(String(r.unit_type_id));
      typeByPair.set(pair, list);
    }
    offset += res.rows.length;
    if (res.rows.length < 10000) break;
  }

  const buildings = new Map<string, { complexId: string; physical: number | null }>();
  offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT building_id, complex_id, physical_household_count, residential_flag, status
            FROM complex_buildings ORDER BY building_id LIMIT 8000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) {
      buildings.set(String(r.building_id), {
        complexId: String(r.complex_id),
        physical: r.physical_household_count == null ? null : Number(r.physical_household_count),
      });
    }
    offset += res.rows.length;
    if (res.rows.length < 8000) break;
  }

  const existing = new Map<string, number>();
  const linkRes = await db.execute(
    `SELECT complex_id, unit_type_id, building_id, household_count, source FROM unit_type_building_links WHERE status='EXACT'`,
  );
  for (const r of linkRes.rows) {
    existing.set(`${r.complex_id}\t${r.unit_type_id}\t${r.building_id}`, Number(r.household_count));
  }

  let coreExact = 0;
  let coreNo = 0;
  let coreDup = 0;
  let bldMissing = 0;
  let cxMismatch = 0;
  let matchedHouseholds = 0;
  const matchedPairs = new Set<string>();
  const unmatchedPairs = new Set<string>();
  const dupPairs = new Set<string>();
  const resolved = new Map<string, { complexId: string; unitTypeId: string; buildingId: string; household: number }>();
  let collapsedSameType = 0;

  for (const row of rows) {
    const b = buildings.get(row.buildingId);
    if (!b) {
      bldMissing += 1;
      continue;
    }
    if (b.complexId !== row.complexId) {
      cxMismatch += 1;
      continue;
    }
    const pair = `${row.complexId}\t${row.exclusiveCents}\t${row.supplyCents}`;
    const ids = typeByPair.get(pair) ?? [];
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      coreNo += 1;
      unmatchedPairs.add(pair);
      continue;
    }
    if (uniqueIds.length > 1) {
      coreDup += 1;
      dupPairs.add(pair);
      continue;
    }
    const unitTypeId = uniqueIds[0];
    if (!/^ut_[0-9a-f]{32}$/.test(unitTypeId)) {
      coreNo += 1;
      unmatchedPairs.add(pair);
      continue;
    }
    coreExact += 1;
    matchedHouseholds += row.household;
    matchedPairs.add(pair);
    const linkKey = `${row.complexId}\t${unitTypeId}\t${row.buildingId}`;
    const prev = resolved.get(linkKey);
    if (prev) {
      collapsedSameType += 1;
      prev.household += row.household;
    } else {
      resolved.set(linkKey, {
        complexId: row.complexId,
        unitTypeId,
        buildingId: row.buildingId,
        household: row.household,
      });
    }
  }

  let match = 0;
  let expand = 0;
  let neu = 0;
  let conflict = 0;
  const publish = new Map<string, { complexId: string; unitTypeId: string; buildingId: string; household: number; action: "insert" | "expand" }>();
  for (const [key, row] of resolved) {
    const prev = existing.get(key);
    if (prev == null) {
      neu += 1;
      publish.set(key, { ...row, action: "insert" });
    } else if (prev === row.household) {
      match += 1;
    } else if (row.household > prev) {
      expand += 1;
      publish.set(key, { ...row, action: "expand" });
    } else {
      conflict += 1;
    }
  }

  const physicalByCx = new Map<string, number>();
  for (const b of buildings.values()) {
    if (b.physical == null) continue;
    physicalByCx.set(b.complexId, (physicalByCx.get(b.complexId) ?? 0) + b.physical);
  }

  let v2ViolB = 0;
  let v2ViolC = 0;
  const v2Building = new Map<string, number>();
  const v2Complex = new Map<string, number>();
  for (const row of resolved.values()) {
    v2Building.set(row.buildingId, (v2Building.get(row.buildingId) ?? 0) + row.household);
    v2Complex.set(row.complexId, (v2Complex.get(row.complexId) ?? 0) + row.household);
  }
  for (const [buildingId, sum] of v2Building) {
    const cap = buildings.get(buildingId)?.physical;
    if (cap != null && sum > cap) v2ViolB += 1;
  }
  for (const [complexId, sum] of v2Complex) {
    const cap = physicalByCx.get(complexId);
    if (cap != null && sum > cap) v2ViolC += 1;
  }

  let heldSafety = 0;
  for (const [key, row] of [...publish]) {
    if (buildings.get(row.buildingId)?.physical == null) {
      publish.delete(key);
      heldSafety += 1;
    }
  }
  const totals = () => {
    const byBuilding = new Map<string, number>();
    const byComplex = new Map<string, number>();
    for (const [key, hh] of existing) {
      if (publish.get(key)?.action === "expand") continue;
      const [complexId, , buildingId] = key.split("\t");
      byBuilding.set(buildingId, (byBuilding.get(buildingId) ?? 0) + hh);
      byComplex.set(complexId, (byComplex.get(complexId) ?? 0) + hh);
    }
    for (const row of publish.values()) {
      byBuilding.set(row.buildingId, (byBuilding.get(row.buildingId) ?? 0) + row.household);
      byComplex.set(row.complexId, (byComplex.get(row.complexId) ?? 0) + row.household);
    }
    return { byBuilding, byComplex };
  };
  for (let guard = 0; guard < 4; guard += 1) {
    const { byBuilding, byComplex } = totals();
    const badB = new Set<string>();
    const badC = new Set<string>();
    for (const [buildingId, sum] of byBuilding) {
      const cap = buildings.get(buildingId)?.physical;
      if (cap != null && sum > cap) badB.add(buildingId);
    }
    for (const [complexId, sum] of byComplex) {
      const cap = physicalByCx.get(complexId);
      if (cap != null && sum > cap) badC.add(complexId);
    }
    let removed = 0;
    for (const [key, row] of [...publish]) {
      if (badB.has(row.buildingId) || badC.has(row.complexId)) {
        publish.delete(key);
        removed += 1;
        heldSafety += 1;
      }
    }
    if (removed === 0) break;
  }
  const finalTotals = totals();
  let violB = 0;
  let violC = 0;
  let legacyOnlyOver = 0;
  for (const [buildingId, sum] of finalTotals.byBuilding) {
    const cap = buildings.get(buildingId)?.physical;
    if (cap == null) continue;
    if (sum > cap) {
      violB += 1;
      const added = [...publish.values()].some((row) => row.buildingId === buildingId);
      if (!added) legacyOnlyOver += 1;
    }
  }
  for (const [complexId, sum] of finalTotals.byComplex) {
    const cap = physicalByCx.get(complexId);
    if (cap != null && sum > cap) violC += 1;
  }

  const pilotIncoming = new Map<string, number>();
  for (const row of rows) pilotIncoming.set(row.complexId, (pilotIncoming.get(row.complexId) ?? 0) + row.household);
  const pilots: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(PILOTS)) {
    const got = pilotIncoming.get(spec.id) ?? 0;
    let publishHouseholds = 0;
    for (const row of publish.values()) {
      if (row.complexId === spec.id) publishHouseholds += row.household;
    }
    for (const [key, row] of resolved) {
      if (row.complexId !== spec.id || publish.has(key)) continue;
      const prev = existing.get(key);
      if (prev != null) publishHouseholds += prev === row.household ? row.household : prev;
    }
    pilots[name] = {
      households: got,
      expected: spec.exact,
      ok: got === spec.exact,
      publishHouseholds,
    };
  }

  const distinctComplexes = new Set<string>();
  const distinctBuildings = new Set<string>();
  const distinctTypes = new Set<string>();
  for (const row of resolved.values()) {
    distinctComplexes.add(row.complexId);
    distinctBuildings.add(row.buildingId);
    distinctTypes.add(row.unitTypeId);
  }

  const report = {
    apply: APPLY,
    input: { rows: rows.length, households, dupKeys, distinctPairs: pairs.size, multiSupplyExclusiveKeys: multiSupply },
    core: {
      CORE_EXACT_MATCH: coreExact,
      matchedHouseholds,
      matchedComplexes: distinctComplexes.size,
      matchedBuildings: distinctBuildings.size,
      matchedUnitTypes: distinctTypes.size,
      matchedPairs: matchedPairs.size,
      unmatchedPairs: unmatchedPairs.size,
      CORE_NO_MATCH: coreNo,
      CORE_DUPLICATE_MATCH: coreDup,
      duplicateCorePairs: dupPairs.size,
      BUILDING_MISSING: bldMissing,
      COMPLEX_MISMATCH: cxMismatch,
      collapsedSameType,
    },
    parity: { MATCH_EXISTING: match, EXPAND_EXISTING: expand, NEW_EXACT: neu, CONFLICT: conflict },
    safety: {
      v2OnlyBuildingViolations: v2ViolB,
      v2OnlyComplexViolations: v2ViolC,
      afterHoldBuildingViolations: violB,
      afterHoldComplexViolations: violC,
      legacyOnlyBuildingOver: legacyOnlyOver,
      heldForSafety: heldSafety,
    },
    publish: {
      inserts: [...publish.values()].filter((r) => r.action === "insert").length,
      updates: [...publish.values()].filter((r) => r.action === "expand").length,
      held: heldSafety + conflict + coreNo + coreDup + bldMissing + cxMismatch,
    },
    pilots,
    gate:
      dupKeys === 0 &&
      coreDup === 0 &&
      collapsedSameType === 0 &&
      v2ViolB === 0 &&
      v2ViolC === 0 &&
      violB === legacyOnlyOver &&
      violC === 0 &&
      cxMismatch === 0 &&
      Object.values(pilots).every((p) => (p as { ok: boolean }).ok),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!APPLY || !report.gate) {
    if (APPLY && !report.gate) console.error("GATE_CLOSED");
    return;
  }

  const ts = new Date().toISOString();
  const stmts: { sql: string; args: unknown[] }[] = [];
  for (const row of publish.values()) {
    if (row.action === "insert") {
      stmts.push({
        sql: `INSERT INTO unit_type_building_links (
                complex_id, unit_type_id, building_id, household_count, source, source_key,
                confidence, status, source_as_of, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'exact', 'EXACT', '2026-08', ?, ?, ?)`,
        args: [
          row.complexId,
          row.unitTypeId,
          row.buildingId,
          row.household,
          SOURCE,
          `${row.buildingId}:${row.unitTypeId}`,
          JSON.stringify({ resolutionStatus: "EXACT_TYPE_BUILDING", version: VERSION }),
          ts,
          ts,
        ],
      });
    } else {
      stmts.push({
        sql: `UPDATE unit_type_building_links
              SET household_count=?, source=?, provenance_json=?, updated_at=?
              WHERE complex_id=? AND unit_type_id=? AND building_id=? AND status='EXACT'
                AND household_count < ?`,
        args: [
          row.household,
          SOURCE,
          JSON.stringify({ resolutionStatus: "EXACT_TYPE_BUILDING", version: VERSION }),
          ts,
          row.complexId,
          row.unitTypeId,
          row.buildingId,
          row.household,
        ],
      });
    }
  }
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40) as never, "write");
    if (i > 0 && i % 4000 === 0) console.error("wrote", i, "/", stmts.length);
  }

  const timings: Record<string, { liveMs: number; bytes: number; physicalSum: number; typedSum: number; coreIds: number }> = {};
  for (const spec of Object.values(PILOTS)) {
    const t0 = Date.now();
    const live = await loadComplexBuildingsApiLive(db, spec.id);
    const liveMs = Date.now() - t0;
    if (live) await upsertApiSnapshot(db, spec.id, live);
    const typed = (live?.buildings ?? []).reduce(
      (n, b) => n + b.unitTypes.reduce((m, t) => m + (t.householdCount ?? 0), 0),
      0,
    );
    const physical = (live?.buildings ?? []).reduce((n, b) => n + (b.physicalHouseholdCount ?? 0), 0);
    const coreIds = (live?.buildings ?? []).reduce(
      (n, b) => n + b.unitTypes.filter((t) => /^ut_[0-9a-f]{32}$/.test(t.unitTypeId)).length,
      0,
    );
    timings[spec.id] = { liveMs, bytes: payloadBytes(live), physicalSum: physical, typedSum: typed, coreIds };
  }
  const out = join(process.cwd(), "data/poc/building-topology/exact-type-v2-publish.json");
  mkdirSync(join(process.cwd(), "data/poc/building-topology"), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, api: timings, appliedAt: ts, writes: stmts.length }, null, 2));
  console.log("wrote", out, "statements", stmts.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
