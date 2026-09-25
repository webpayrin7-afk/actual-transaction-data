/**
 * 지번이 새로 채워진 지방 단지(fill-master-jibun.mts)의 좌표 빈 칸 채우기 — 필지 대표점(AL_D002)만.
 * LIVING 좌표 작업과 같은 뜻: PARCEL_REPRESENTATIVE_POINT, PNU 정확 일치, 지오코딩·건물 중심점 없음.
 *
 *   1) targets : 좌표(latitude/longitude)가 둘 다 NULL이고 지번이 있는 단지 → 지적 PNU(대지 1 / 산 2) 목록 CSV
 *                같은 필지를 가진 단지가 둘 이상이거나, 그 PNU가 이미 다른 단지 좌표 출처로 쓰였으면 보류(AMBIGUOUS_PARCEL).
 *   2) 로컬 추출: python C:/data/cadastre/2026-09/local-extract-residual-parcels.py --targets <targets.csv> --zips C:/data/cadastre/2026-09 --out <points.csv.gz>
 *   3) 계획/쓰기: 좌표가 여전히 둘 다 NULL인 단지만 UPDATE, complex_parcel_coordinates는 없는 행만 INSERT.
 *
 *   npx tsx scripts/fixes/parcel-coords-new-jibun.mts targets
 *   npx tsx scripts/fixes/parcel-coords-new-jibun.mts plan  --input <points.csv.gz>
 *   npx tsx scripts/fixes/parcel-coords-new-jibun.mts apply --input <points.csv.gz>
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/master-jibun-2026-09-26";
const TARGETS = join(OUT, "coord-targets.csv");
const NEW_READY = join(OUT, "coord-newly-ready.jsonl");
const SOURCE = "국토교통부 일별연속지적도형정보 AL_D002";
const DATASET = "국토교통부 일별연속지적도형정보";

function cadastralPnu(lawd: string, bjdong: string, jibun: string): string | null {
  const m = /^(산)?(\d{1,4})(?:-(\d{1,4}))?$/.exec(jibun.trim());
  if (!m || !/^\d{5}$/.test(lawd) || !/^\d{5}$/.test(bjdong)) return null;
  return `${lawd}${bjdong}${m[1] ? "2" : "1"}${m[2]!.padStart(4, "0")}${(m[3] ?? "0").padStart(4, "0")}`;
}

async function targets() {
  const db = getDb()!;
  const res = await db.execute(`
    SELECT m.complex_id, m.sido_code, m.lawd_cd, m.bjdong_cd, m.jibun
    FROM apt_complex_master m
    LEFT JOIN complex_parcel_coordinates p ON p.complex_id = m.complex_id
    WHERE m.latitude IS NULL AND m.longitude IS NULL AND m.jibun IS NOT NULL AND m.jibun <> '' AND p.complex_id IS NULL`);
  const dup = await db.execute(`
    SELECT lawd_cd || '|' || bjdong_cd || '|' || jibun AS k FROM apt_complex_master
    WHERE jibun IS NOT NULL AND jibun <> '' GROUP BY lawd_cd, bjdong_cd, jibun HAVING count(*) > 1`);
  const shared = new Set(dup.rows.map((r) => String(r.k)));
  const used = new Set((await db.execute(`SELECT pnu FROM complex_parcel_coordinates`)).rows.map((r) => String(r.pnu)));
  const held: Record<string, number> = {};
  const lines = ["complex_id,pnu,sido_code"];
  for (const r of res.rows) {
    const pnu = cadastralPnu(String(r.lawd_cd), String(r.bjdong_cd), String(r.jibun));
    let hold = "";
    if (!pnu) hold = "PNU_BUILD_FAILED";
    else if (shared.has(`${r.lawd_cd}|${r.bjdong_cd}|${r.jibun}`) || used.has(pnu)) hold = "AMBIGUOUS_PARCEL";
    if (hold) {
      held[hold] = (held[hold] ?? 0) + 1;
      continue;
    }
    lines.push(`${r.complex_id},${pnu},${r.sido_code}`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(TARGETS, lines.join("\n") + "\n");
  console.log(JSON.stringify({ nullCoordWithJibun: res.rows.length, targets: lines.length - 1, held, file: TARGETS }));
}

type Point = { complexId: string; pnu: string; lat: string; lon: string; sidoCode: string; version: string; crs: string };

function readPoints(path: string): Point[] {
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  const [header, ...rows] = text.split(/\r?\n/).filter(Boolean);
  if (header !== "complex_id,pnu,lat,lon,source_region,source_filename,source_version,source_crs,coordinate_semantics,resolution_status")
    throw new Error(`header ${header}`);
  return rows.map((l) => {
    const c = l.split(",");
    if (c.length !== 10 || c[8] !== "PARCEL_REPRESENTATIVE_POINT" || c[9] !== "EXACT_PNU") throw new Error(`row ${l}`);
    return { complexId: c[0]!, pnu: c[1]!, lat: c[2]!, lon: c[3]!, sidoCode: c[4]!, version: c[6]!, crs: c[7]! };
  });
}

async function planOrApply(input: string, apply: boolean) {
  const db = getDb()!;
  const points = readPoints(input);
  const wanted = new Map(
    readFileSync(TARGETS, "utf8")
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => {
        const [id, pnu, sido] = l.split(",");
        return [id!, { pnu: pnu!, sido: sido! }] as const;
      }),
  );
  const counts: Record<string, number> = {};
  const fills: Point[] = [];
  for (const p of points) {
    const w = wanted.get(p.complexId);
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    let k = "NULL_SAFE_FILL";
    if (!w || w.pnu !== p.pnu || w.sido !== p.sidoCode) k = "NOT_A_TARGET";
    else if (!(lat >= 33 && lat <= 39.6 && lon >= 124 && lon <= 132.2)) k = "BBOX";
    counts[k] = (counts[k] ?? 0) + 1;
    if (k === "NULL_SAFE_FILL") fills.push(p);
  }
  // 지금도 좌표가 비어 있는지 다시 본다
  const stillNull = new Set<string>();
  for (let i = 0; i < fills.length; i += 200) {
    const ids = fills.slice(i, i + 200).map((f) => f.complexId);
    const r = await db.execute({
      sql: `SELECT m.complex_id FROM apt_complex_master m LEFT JOIN complex_parcel_coordinates p ON p.complex_id = m.complex_id
            WHERE m.complex_id IN (${ids.map(() => "?").join(",")}) AND m.latitude IS NULL AND m.longitude IS NULL AND p.complex_id IS NULL`,
      args: ids,
    });
    for (const x of r.rows) stillNull.add(String(x.complex_id));
  }
  const ready = fills.filter((f) => stillNull.has(f.complexId));
  const bySido = ready.reduce<Record<string, number>>((a, f) => ((a[f.sidoCode] = (a[f.sidoCode] ?? 0) + 1), a), {});
  console.log(JSON.stringify({ points: points.length, targets: wanted.size, counts, fill: ready.length, alreadyFilled: fills.length - ready.length, bySido }));
  if (!apply) return;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let updated = 0;
  let inserted = 0;
  for (let i = 0; i < ready.length; i += 100) {
    const part = ready.slice(i, i + 100);
    const out = await db.batch(
      part.flatMap((p) => [
        {
          sql: `UPDATE apt_complex_master SET latitude = ?, longitude = ?, updated_at = ?
                WHERE complex_id = ? AND sido_code = ? AND latitude IS NULL AND longitude IS NULL`,
          args: [p.lat, p.lon, now, p.complexId, p.sidoCode],
        },
        {
          sql: `INSERT OR IGNORE INTO complex_parcel_coordinates (
                  complex_id, pnu, latitude, longitude, coordinate_semantics, resolution_status,
                  coordinate_source, source_object_id, source_version, source_dataset, generated_at
                ) VALUES (?, ?, ?, ?, 'PARCEL_REPRESENTATIVE_POINT', 'EXACT_PNU', ?, ?, ?, ?, ?)`,
          args: [p.complexId, p.pnu, p.lat, p.lon, SOURCE, p.pnu, p.version, DATASET, now],
        },
      ]),
      "write",
    );
    out.forEach((r, j) => (j % 2 === 0 ? (updated += r.rowsAffected) : (inserted += r.rowsAffected)));
  }
  writeFileSync(NEW_READY, ready.map((p) => JSON.stringify({ complex_id: p.complexId, latitude: p.lat, longitude: p.lon, sido_code: p.sidoCode })).join("\n") + "\n");
  console.log(JSON.stringify({ updated, inserted, newlyReadyFile: NEW_READY }));
}

const [mode] = process.argv.slice(2);
const ii = process.argv.indexOf("--input");
const input = ii > 0 ? process.argv[ii + 1]! : join(OUT, "coord-points.csv.gz");
if (mode === "targets") await targets();
else if (mode === "plan") await planOrApply(input, false);
else if (mode === "apply") await planOrApply(input, true);
else console.error("usage: parcel-coords-new-jibun.mts targets | plan --input f | apply --input f");
