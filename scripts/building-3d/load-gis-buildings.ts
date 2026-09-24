/**
 * build-gis-buildings.py 결과(NDJSON) → gis_buildings. 이 테이블 외 쓰기 없음.
 *
 *   npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson          # dry-run
 *   npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson --apply
 *
 * 같은 bld_key는 원천 값이 바뀌었을 때만(payload_hash) 갱신. 다시 돌리면 insert·update 0.
 * 단지 동 연결은 읽을 때 한다: complex_buildings.mgm_bldrgst_pk = (기관코드 5자리) + gis_buildings.bldrgst_pk,
 * 같은 시·군·구(lawd_cd) 안에서만 (보고용으로 연결 수만 센다). 예: 10891|100208583 ↔ 100208583.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getDb } from "../../src/lib/db/client";

type Cell = string | number | null;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const COLS = [
  "bld_key", "bldrgst_pk", "pnu", "bjdong_cd", "lawd_cd", "name", "dong_name", "use_code", "use_name", "structure",
  "height_m", "floors_above", "floors_below", "building_area", "total_floor_area", "approval_date",
  "lat", "lng", "rings", "source_date", "change_type",
] as const;

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const from = arg("from");
  if (!from) throw new Error("--from=<ndjson> 이 필요합니다.");
  const apply = process.argv.includes("--apply");

  const rows: Array<Record<string, Cell>> = [];
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const v: Record<string, Cell> = {};
    for (const c of COLS) v[c] = c === "rings" ? JSON.stringify(r.rings) : ((r[c] ?? null) as Cell);
    v.payload_hash = createHash("sha1").update(JSON.stringify(v)).digest("hex");
    rows.push(v);
  }

  const exists =
    (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gis_buildings'")).rows.length > 0;
  const have = new Map<string, string>();
  if (exists) {
    for (const r of (await db.execute("SELECT bld_key, payload_hash FROM gis_buildings")).rows) {
      have.set(String(r.bld_key), String(r.payload_hash));
    }
  }
  const seen = new Set<string>();
  const changed: typeof rows = [];
  let ins = 0;
  let dup = 0;
  for (const r of rows) {
    const k = String(r.bld_key);
    if (seen.has(k)) {
      dup++;
      continue;
    }
    seen.add(k);
    const h = have.get(k);
    if (h === r.payload_hash) continue;
    if (h == null) ins++;
    changed.push(r);
  }

  // 단지 동 연결 보고 — 건축물대장 번호(앞 5자리 기관코드 제외)와 시·군·구가 모두 같은 건물 수
  const keys = new Set(
    rows.filter((r) => r.bldrgst_pk && r.lawd_cd).map((r) => `${r.lawd_cd}|${r.bldrgst_pk}`),
  );
  const cb = await db.execute(`SELECT cb.complex_id, cb.mgm_bldrgst_pk, m.lawd_cd FROM complex_buildings cb
    JOIN apt_complex_master m ON m.complex_id = cb.complex_id WHERE cb.mgm_bldrgst_pk IS NOT NULL`);
  const linkedComplexes = new Set<string>();
  let linkedBuildings = 0;
  for (const r of cb.rows) {
    const pk = String(r.mgm_bldrgst_pk);
    if (pk.length > 5 && keys.has(`${r.lawd_cd}|${pk.slice(5)}`)) {
      linkedBuildings++;
      linkedComplexes.add(String(r.complex_id));
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        buildings: { rows: rows.length, insert: ins, update: changed.length - ins, unchanged: rows.length - dup - changed.length, duplicate_keys: dup },
        links_by_bldrgst_pk: { complexes: linkedComplexes.size, buildings: linkedBuildings },
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260928_building_3d.sql"), "utf8");
  for (const stmt of ddl
    .split(/;\s*\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)) {
    await db.execute(stmt);
  }
  const now = new Date().toISOString();
  const cols = [...COLS, "payload_hash", "loaded_at"];
  let affected = 0;
  for (let i = 0; i < changed.length; i += 100) {
    const res = await db.batch(
      changed.slice(i, i + 100).map((r) => ({
        sql: `INSERT OR REPLACE INTO gis_buildings (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        args: [...COLS.map((c) => r[c] ?? null), r.payload_hash ?? null, now],
      })),
      "write",
    );
    affected += res.reduce((a, x) => a + x.rowsAffected, 0);
  }
  console.log(JSON.stringify({ applied: { buildings: affected } }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
