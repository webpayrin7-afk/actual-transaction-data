import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { createClient } from "@libsql/client";

const UP = "/home/ubuntu/.cursor/projects/workspace/uploads";

async function readCsv(path: string): Promise<string[][]> {
  const rl = readline.createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  const rows: string[][] = [];
  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;
    rows.push(line.split(","));
  }
  return rows;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const phys = await readCsv(`${UP}/building_physical_households.csv_78d4.gz`);
  const exact = await readCsv(`${UP}/exact_type_building_households.csv_66ac.gz`);

  const buildings = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT building_id, complex_id, residential_flag, status FROM complex_buildings ORDER BY building_id LIMIT 8000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) buildings.set(String(r.building_id), `${r.complex_id}|${r.residential_flag}|${r.status}`);
    offset += res.rows.length;
    if (res.rows.length < 8000) break;
  }

  let physOk = 0;
  let physMissing = 0;
  let physComplexMismatch = 0;
  let physNotResidentialExact = 0;
  for (const [complexId, buildingId] of phys) {
    const hit = buildings.get(buildingId);
    if (!hit) {
      physMissing += 1;
      continue;
    }
    const [cx, resFlag, status] = hit.split("|");
    if (cx !== complexId) physComplexMismatch += 1;
    else if (resFlag !== "1" || status !== "EXACT") physNotResidentialExact += 1;
    else physOk += 1;
  }

  const types = new Set<string>();
  offset = 0;
  for (;;) {
    const res = await db.execute({
      sql: `SELECT complex_id, unit_type_id FROM apt_canonical_unit_types ORDER BY unit_type_id LIMIT 8000 OFFSET ?`,
      args: [offset],
    });
    if (!res.rows.length) break;
    for (const r of res.rows) types.add(`${r.complex_id}|${r.unit_type_id}`);
    offset += res.rows.length;
    if (res.rows.length < 8000) break;
  }

  const links = new Map<string, number>();
  const linkRes = await db.execute(
    `SELECT complex_id, unit_type_id, building_id, household_count, status FROM unit_type_building_links`,
  );
  for (const r of linkRes.rows) {
    links.set(`${r.complex_id}|${r.unit_type_id}|${r.building_id}`, Number(r.household_count));
  }

  let exactOk = 0;
  let typeMissing = 0;
  let bldMissing = 0;
  let match = 0;
  let expand = 0;
  let conflict = 0;
  let neu = 0;
  const existingKeys = new Set(links.keys());
  const seenIncoming = new Set<string>();
  for (const [complexId, unitTypeId, buildingId, hh] of exact) {
    const n = Number(hh);
    const b = buildings.get(buildingId);
    if (!b || b.split("|")[0] !== complexId) {
      bldMissing += 1;
      continue;
    }
    if (!types.has(`${complexId}|${unitTypeId}`)) {
      typeMissing += 1;
      continue;
    }
    exactOk += 1;
    const key = `${complexId}|${unitTypeId}|${buildingId}`;
    seenIncoming.add(key);
    if (!links.has(key)) neu += 1;
    else {
      const prev = links.get(key)!;
      if (prev === n) match += 1;
      else if (n > prev) expand += 1;
      else conflict += 1;
    }
  }
  let existingNotInIncoming = 0;
  for (const key of existingKeys) if (!seenIncoming.has(key)) existingNotInIncoming += 1;

  const before = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM complex_buildings WHERE residential_flag=1) residential,
      (SELECT COUNT(*) FROM unit_type_building_links WHERE status='EXACT') links,
      (SELECT COUNT(DISTINCT complex_id) FROM unit_type_building_links WHERE status='EXACT') complexes
  `);

  console.log(JSON.stringify({
    buildingsLoaded: buildings.size,
    typesLoaded: types.size,
    existingLinks: links.size,
    before: before.rows[0],
    phys: { rows: phys.length, ok: physOk, missing: physMissing, complexMismatch: physComplexMismatch, notResidentialExact: physNotResidentialExact },
    exact: { rows: exact.length, ok: exactOk, typeMissing, bldMissing, match, expand, conflict, neu, existingNotInIncoming },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
