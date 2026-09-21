/**
 * Compact national unit↔building ingest.
 * Physical household totals publish only when building_id+complex_id match canonical inventory.
 * Exact type links publish only when canonical_unit_type_id exists in apt_canonical_unit_types.
 * Unresolved statuses are internal holds, never public exact links.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureBuildingSchema } from "@/lib/buildings/schema";
import { loadComplexBuildingsApiLive } from "@/lib/buildings/api";
import { payloadBytes } from "@/lib/buildings/geometry";
import { upsertApiSnapshot } from "@/lib/buildings/repository";

const VERSION = "building-unit-link|buildinghub-2026-08|exact-dong-v1";
const UP = process.env.COMPACT_INGEST_DIR
  ?? "/home/ubuntu/.cursor/projects/workspace/uploads";
const APPLY = process.argv.includes("--apply");

const PILOTS: Record<string, { id: string; physical: number; linked: number; buildings: number; exactType: number | null }> = {
  "잠실엘스": { id: "cx_4c63d9a100973c60", physical: 5678, linked: 5678, buildings: 72, exactType: null },
  "파크리오": { id: "cx_ed52bf895d064c11", physical: 6864, linked: 6864, buildings: 66, exactType: null },
  "리센츠": { id: "cx_caf229b5ac63cfbd", physical: 5564, linked: 5564, buildings: 65, exactType: null },
  "헬리오시티": { id: "cx_30d7eea6da810b52", physical: 10134, linked: 9510, buildings: 84, exactType: null },
  "반포자이": { id: "cx_1c244e7305d12c44", physical: 3411, linked: 3410, buildings: 44, exactType: null },
  "래미안퍼스티지": { id: "cx_3bcf0f87bce7496b", physical: 2444, linked: 2444, buildings: 28, exactType: null },
  "은마": { id: "cx_0320fd9e007e1f8c", physical: 4922, linked: 4454, buildings: 29, exactType: 0 },
  "도곡렉슬": { id: "cx_c9ed0235ecca960c", physical: 3003, linked: 3002, buildings: 34, exactType: null },
  "마포프레스티지자이": { id: "cx_07caf64c556e85a7", physical: 1797, linked: 1694, buildings: 18, exactType: null },
  "포레나노원": { id: "cx_88d05e29df26a0d6", physical: 1078, linked: 1062, buildings: 13, exactType: null },
};

async function readCsv(name: string): Promise<string[][]> {
  const rl = readline.createInterface({
    input: createReadStream(join(UP, name)).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  const rows: string[][] = [];
  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (line) rows.push(line.split(","));
  }
  return rows;
}

async function loadBuildings(db: Client): Promise<Map<string, string>> {
  const buildings = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT building_id, complex_id, residential_flag, status,
                   physical_household_count, physical_household_version
            FROM complex_buildings ORDER BY building_id LIMIT 8000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) {
      buildings.set(String(r.building_id), [
        r.complex_id,
        r.residential_flag,
        r.status,
        r.physical_household_count ?? "",
        r.physical_household_version ?? "",
      ].join("\t"));
    }
    offset += res.rows.length;
    if (res.rows.length < 8000) break;
  }
  return buildings;
}

async function loadTypes(db: Client): Promise<Set<string>> {
  const types = new Set<string>();
  let offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT complex_id, unit_type_id FROM apt_canonical_unit_types LIMIT 10000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) types.add(`${r.complex_id}|${r.unit_type_id}`);
    offset += res.rows.length;
    if (res.rows.length < 10000) break;
  }
  return types;
}

async function batch(db: Client, stmts: { sql: string; args: unknown[] }[]) {
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40) as never, "write");
  }
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  await ensureBuildingSchema(db);
  const phys = await readCsv("building_physical_households.csv_78d4.gz");
  const exact = await readCsv("exact_type_building_households.csv_66ac.gz");
  const cov = await readCsv("complex_building_coverage.csv_95c4.gz");
  const unresolved = await readCsv("building_unit_unresolved_summary.csv_dbd8.gz");
  const buildings = await loadBuildings(db);
  const types = await loadTypes(db);
  const existing = await db.execute(
    `SELECT complex_id, unit_type_id, building_id, household_count FROM unit_type_building_links WHERE status='EXACT'`,
  );
  const links = new Map<string, number>();
  for (const r of existing.rows) {
    links.set(`${r.complex_id}|${r.unit_type_id}|${r.building_id}`, Number(r.household_count));
  }
  const holds = await db.execute(
    `SELECT complex_id, resolution_status, household_count, source_version FROM building_unit_unresolved_holds`,
  );
  const holdMap = new Map<string, string>();
  for (const r of holds.rows) {
    holdMap.set(`${r.complex_id}|${r.resolution_status}`, `${r.household_count}|${r.source_version}`);
  }

  const ts = new Date().toISOString();
  const physWrites: { sql: string; args: unknown[] }[] = [];
  let physInsert = 0;
  let physUpdate = 0;
  let physUnchanged = 0;
  let physHeld = 0;
  for (const [complexId, buildingId, count] of phys) {
    const hit = buildings.get(buildingId);
    if (!hit) {
      physHeld += 1;
      continue;
    }
    const [cx, flag, status, prevCount, prevVer] = hit.split("\t");
    if (cx !== complexId || flag !== "1" || status !== "EXACT") {
      physHeld += 1;
      continue;
    }
    if (prevCount === count && prevVer === VERSION) {
      physUnchanged += 1;
      continue;
    }
    if (prevCount === "") physInsert += 1;
    else physUpdate += 1;
    physWrites.push({
      sql: `UPDATE complex_buildings
            SET physical_household_count=?, physical_household_version=?, updated_at=?
            WHERE building_id=? AND complex_id=? AND residential_flag=1 AND status='EXACT'`,
      args: [Number(count), VERSION, ts, buildingId, complexId],
    });
  }

  let match = 0;
  let expand = 0;
  let conflict = 0;
  let neu = 0;
  let typeHeld = 0;
  const typeWrites: { sql: string; args: unknown[] }[] = [];
  for (const [complexId, unitTypeId, buildingId, hh] of exact) {
    const n = Number(hh);
    const b = buildings.get(buildingId);
    if (!b || b.split("\t")[0] !== complexId || !types.has(`${complexId}|${unitTypeId}`)) {
      typeHeld += 1;
      continue;
    }
    const key = `${complexId}|${unitTypeId}|${buildingId}`;
    if (!links.has(key)) {
      neu += 1;
      typeWrites.push({
        sql: `INSERT INTO unit_type_building_links (
                complex_id, unit_type_id, building_id, household_count, source, source_key,
                confidence, status, source_as_of, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'exact', 'EXACT', ?, ?, ?, ?)`,
        args: [
          complexId, unitTypeId, buildingId, n,
          "buildinghub-2026-08.exact-dong-v1",
          `${buildingId}:${unitTypeId}`,
          "2026-08",
          JSON.stringify({ resolutionStatus: "EXACT_TYPE_BUILDING", version: VERSION }),
          ts, ts,
        ],
      });
      continue;
    }
    const prev = links.get(key)!;
    if (prev === n) match += 1;
    else if (n > prev) {
      expand += 1;
      typeWrites.push({
        sql: `UPDATE unit_type_building_links
              SET household_count=?, source=?, source_as_of=?, provenance_json=?, updated_at=?
              WHERE complex_id=? AND unit_type_id=? AND building_id=? AND status='EXACT'
                AND household_count=?`,
        args: [
          n, "buildinghub-2026-08.exact-dong-v1", "2026-08",
          JSON.stringify({ resolutionStatus: "EXACT_TYPE_BUILDING", version: VERSION, prior: prev }),
          ts, complexId, unitTypeId, buildingId, prev,
        ],
      });
    } else conflict += 1;
  }

  const holdWrites: { sql: string; args: unknown[] }[] = [];
  let holdInsert = 0;
  let holdUpdate = 0;
  let holdUnchanged = 0;
  for (const [complexId, status, count] of unresolved) {
    const key = `${complexId}|${status}`;
    const prev = holdMap.get(key);
    if (prev === `${count}|${VERSION}`) {
      holdUnchanged += 1;
      continue;
    }
    if (!prev) holdInsert += 1;
    else holdUpdate += 1;
    holdWrites.push({
      sql: `INSERT INTO building_unit_unresolved_holds (
              complex_id, resolution_status, household_count, source_version, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(complex_id, resolution_status) DO UPDATE SET
              household_count=excluded.household_count,
              source_version=excluded.source_version,
              updated_at=excluded.updated_at`,
      args: [complexId, status, Number(count), VERSION, ts],
    });
  }

  const pilots: Record<string, unknown> = {};
  const byCx = new Map(cov.map((r) => [r[0], r]));
  for (const [name, spec] of Object.entries(PILOTS)) {
    const row = byCx.get(spec.id);
    pilots[name] = row
      ? {
          physical: Number(row[1]),
          linked: Number(row[2]),
          exactType: Number(row[3]),
          groupOnly: Number(row[4]),
          noCanonical: Number(row[5]),
          noBuilding: Number(row[6]),
          buildings: Number(row[7]),
          coverage: row[9],
          physicalRefOk: Number(row[1]) === spec.physical,
          linkedRefOk: Number(row[2]) === spec.linked,
          buildingsRefOk: Number(row[7]) === spec.buildings,
          exactTypeRefOk: spec.exactType == null ? null : Number(row[3]) === spec.exactType,
        }
      : { missing: true };
  }

  const report = {
    apply: APPLY,
    version: VERSION,
    physical: {
      incoming: phys.length,
      insert: physInsert,
      update: physUpdate,
      unchanged: physUnchanged,
      held: physHeld,
      writes: physWrites.length,
    },
    type: {
      incoming: exact.length,
      match,
      expand,
      neu,
      conflict,
      held: typeHeld,
      writes: typeWrites.length,
      holdReason: typeHeld === exact.length ? "CANONICAL_TYPE_ID_NOT_IN_CORE" : "",
    },
    unresolved: {
      incoming: unresolved.length,
      insert: holdInsert,
      update: holdUpdate,
      unchanged: holdUnchanged,
    },
    pilots,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!APPLY) return;
  await batch(db, physWrites);
  await batch(db, typeWrites);
  await batch(db, holdWrites);

  const timings: Record<string, { liveMs: number; bytes: number; buildings: number; physicalSum: number }> = {};
  for (const spec of Object.values(PILOTS)) {
    const t0 = Date.now();
    const live = await loadComplexBuildingsApiLive(db, spec.id);
    const liveMs = Date.now() - t0;
    if (live) await upsertApiSnapshot(db, spec.id, live);
    timings[spec.id] = {
      liveMs,
      bytes: payloadBytes(live),
      buildings: live?.buildings.length ?? 0,
      physicalSum: (live?.buildings ?? []).reduce((n, b) => n + (b.physicalHouseholdCount ?? 0), 0),
    };
  }
  const out = join(process.cwd(), "data/poc/building-topology/compact-ingest-result.json");
  mkdirSync(join(process.cwd(), "data/poc/building-topology"), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, api: timings, appliedAt: ts }, null, 2));
  console.log("wrote", out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
