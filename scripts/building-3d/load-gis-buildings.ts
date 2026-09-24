/**
 * build-gis-buildings.py 결과(NDJSON) → gis_buildings. 이 테이블 외 쓰기 없음.
 *
 *   npx tsx scripts/building-3d/load-gis-buildings.ts --from=C:/data/gis/out/buildings.ndjson
 *   npx tsx scripts/building-3d/load-gis-buildings.ts --from=... --missing-only          # dry-run
 *   npx tsx scripts/building-3d/load-gis-buildings.ts --from=... --missing-only --apply
 *
 * --missing-only: 이미 있는 bld_key는 건드리지 않음 (해시 갱신 없음).
 * 단지 동 연결 보고: complex_buildings.mgm_bldrgst_pk[5:] = gis bldrgst_pk, 같은 lawd_cd.
 * file12_region: lawd 12/29/46 단지 동만 따로 연결률을 보고 (연결 규칙은 같음 — lawd·번호 정확 일치).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
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
  const missingOnly = process.argv.includes("--missing-only");

  const rows: Array<Record<string, Cell> & { keep?: string }> = [];
  let keepA = 0;
  let keepB = 0;
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const v: Record<string, Cell> & { keep?: string } = {};
    for (const c of COLS) v[c] = c === "rings" ? JSON.stringify(r.rings) : ((r[c] ?? null) as Cell);
    v.payload_hash = createHash("sha1").update(JSON.stringify(Object.fromEntries(COLS.map((c) => [c, v[c]])))).digest("hex");
    if (r.keep === "A") keepA++;
    else if (r.keep === "B") keepB++;
    rows.push(v);
  }

  const exists =
    (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gis_buildings'")).rows.length > 0;
  const have = new Map<string, string>();
  let existingCount = 0;
  if (exists) {
    for (const r of (await db.execute("SELECT bld_key, payload_hash FROM gis_buildings")).rows) {
      have.set(String(r.bld_key), String(r.payload_hash));
    }
    existingCount = have.size;
  }
  const seen = new Set<string>();
  const changed: typeof rows = [];
  let ins = 0;
  let dup = 0;
  let skippedExisting = 0;
  for (const r of rows) {
    const k = String(r.bld_key);
    if (seen.has(k)) {
      dup++;
      continue;
    }
    seen.add(k);
    const h = have.get(k);
    if (h != null) {
      if (missingOnly) {
        skippedExisting++;
        continue;
      }
      if (h === r.payload_hash) continue;
    } else {
      ins++;
    }
    changed.push(r);
  }

  const keys = new Set(
    rows.filter((r) => r.bldrgst_pk && r.lawd_cd).map((r) => `${r.lawd_cd}|${r.bldrgst_pk}`),
  );

  const cb = await db.execute(`SELECT cb.complex_id, cb.mgm_bldrgst_pk, cb.dong_label, m.lawd_cd, m.apt_name
    FROM complex_buildings cb
    JOIN apt_complex_master m ON m.complex_id = cb.complex_id
    WHERE cb.mgm_bldrgst_pk IS NOT NULL AND length(cb.mgm_bldrgst_pk) > 5`);

  const linkedComplexes = new Set<string>();
  const linkedBuildingsByComplex = new Map<string, number>();
  const totalByComplex = new Map<string, { n: number; apt: string; lawd: string; samples: string[] }>();
  let linkedBuildings = 0;
  let linkedFile12Region = 0;
  let totalFile12Region = 0;

  for (const r of cb.rows) {
    const cid = String(r.complex_id);
    const pk = String(r.mgm_bldrgst_pk);
    const suf = pk.slice(5);
    const lawd = String(r.lawd_cd);
    const apt = String(r.apt_name ?? "");
    const dong = String(r.dong_label ?? "");
    const t = totalByComplex.get(cid) ?? { n: 0, apt, lawd, samples: [] };
    t.n++;
    if (t.samples.length < 3) t.samples.push(dong || suf);
    totalByComplex.set(cid, t);

    const in12 = lawd.startsWith("12") || lawd.startsWith("29") || lawd.startsWith("46");
    if (in12) totalFile12Region++;
    if (keys.has(`${lawd}|${suf}`)) {
      linkedBuildings++;
      linkedComplexes.add(cid);
      linkedBuildingsByComplex.set(cid, (linkedBuildingsByComplex.get(cid) ?? 0) + 1);
      if (in12) linkedFile12Region++;
    }
  }

  const unlinked: Array<{ complex_id: string; apt_name: string; lawd_cd: string; buildings: number; linked: number; samples: string[] }> = [];
  for (const [cid, t] of totalByComplex) {
    const linked = linkedBuildingsByComplex.get(cid) ?? 0;
    if (linked < t.n) {
      unlinked.push({
        complex_id: cid,
        apt_name: t.apt,
        lawd_cd: t.lawd,
        buildings: t.n,
        linked,
        samples: t.samples,
      });
    }
  }
  unlinked.sort((a, b) => b.buildings - a.buildings || a.linked - b.linked);

  const fromBytes = statSync(from).size;
  const payloadBytes = rows.reduce((a, r) => a + String(r.rings ?? "").length, 0);

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        missing_only: missingOnly,
        source: { path: from, bytes: fromBytes, rows: rows.length, keep_a: keepA, keep_b: keepB },
        buildings: {
          existing: existingCount,
          insert: ins,
          update: missingOnly ? 0 : changed.length - ins,
          unchanged_or_skipped: rows.length - dup - changed.length,
          skipped_existing: skippedExisting,
          duplicate_keys: dup,
          would_write: changed.length,
          rings_payload_bytes: payloadBytes,
        },
        links_by_bldrgst_pk: {
          complex_buildings: cb.rows.length,
          linked_buildings: linkedBuildings,
          linked_complexes: linkedComplexes.size,
          link_rate_buildings: cb.rows.length ? Number((linkedBuildings / cb.rows.length).toFixed(4)) : 0,
          file12_region: {
            complex_buildings: totalFile12Region,
            linked_buildings: linkedFile12Region,
            link_rate: totalFile12Region ? Number((linkedFile12Region / totalFile12Region).toFixed(4)) : 0,
          },
        },
        unlinked_top10: unlinked.slice(0, 10),
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
  const after = await db.execute("SELECT COUNT(*) AS n FROM gis_buildings");
  console.log(JSON.stringify({ applied: { buildings: affected, gis_buildings_total: after.rows[0]?.n } }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
