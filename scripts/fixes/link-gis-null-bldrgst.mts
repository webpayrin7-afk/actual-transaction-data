/**
 * GIS 건물(gis_buildings) 중 건축물대장 번호(원천 A19)가 비어 있는 행에 단지 동의 번호를 채운다 — 3D 동 모양 연결용.
 *
 * 원인: 3D 화면(src/lib/complex-3d/read.ts)은 동 ↔ GIS 건물을 "같은 시군구 + 건축물대장 번호 뒤쪽(앞 5자리 제외) 일치 +
 * 단지 좌표 1km 안"으로만 붙인다. GIS건물통합정보 원천에는 A19가 빈 건물이 있다 (파크리오 66동 전부 —
 * 이름·동명 "파크리오 101동", 층수·높이는 있음). 이 행들은 적재됐지만(B: 5층 이상·단지 근처) 번호가 없어 어떤 동에도 붙지 않는다.
 *
 * 규칙 (추정·유사 이름 없음):
 *   GIS 행(bldrgst_pk IS NULL)의 건물명/동명을 "<이름> <숫자>동"으로 나눠 (둘 다 숫자가 있으면 같아야 함),
 *   같은 시군구(lawd_cd)이고 GIS 건물이 단지 좌표에서 1km 안인 단지의 동 중
 *     - 동 표기(dong_label)가 "<숫자>동" / "제<숫자>동" / "<숫자>"이고 숫자가 같고,
 *     - 이름이 단지명(apt_name·apt_name_norm) 또는 대장 건물명(building_name)과 정규화 후 완전히 같은 것
 *       (정규화: 소문자, 공백·괄호·구두점 제거, "아파트"/"apt" 제거 — 그 밖의 부분 일치 없음).
 *   GIS 행 하나에 동 하나, 동 하나에 GIS 행 하나일 때만 연결. 둘 이상이면 건너뛴다.
 *   층수 둘 다 있고 2층 넘게 다르면 건너뛰고 기록한다. 이미 모양이 붙은 동(같은 번호의 GIS 행이 단지 1km 안)은 건드리지 않는다.
 *
 * 쓰기: UPDATE gis_buildings SET bldrgst_pk = ? WHERE bld_key = ? AND bldrgst_pk IS NULL (빈 값만, 기존 값은 절대 안 바꿈).
 * 적재기(load-gis-buildings.ts)는 payload_hash가 같으면 행을 건너뛰므로 채운 값은 유지된다. 원천 행이 바뀌어 다시 적재되면 이 스크립트를 다시 돌린다.
 * 되돌리기: 계획 파일의 bld_key들을 bldrgst_pk = NULL로.
 *
 *   npx tsx scripts/fixes/link-gis-null-bldrgst.mts            # 계획만 (DB 쓰기 없음) → C:/data/fixes/link-gis-null-bldrgst/plan.json
 *   npx tsx scripts/fixes/link-gis-null-bldrgst.mts --apply    # 방금 만든 계획대로 채운다
 *   npx tsx scripts/fixes/link-gis-null-bldrgst.mts --complex cx_ed52bf895d064c11   # 한 단지만 (계획·적용 모두)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/link-gis-null-bldrgst";
const LINK_MAX_M = 1000; // read.ts A_LINK_MAX_M와 같음
const FLOOR_TOL = 2;

type Link = {
  bld_key: string;
  new_bldrgst_pk: string;
  complex_id: string;
  apt_name: string;
  building_id: string;
  dong_label: string;
  gis_label: string;
  floors_gis: number | null;
  floors_ledger: number | null;
  dist_m: number;
};

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const r = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const norm = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/아파트|apt/g, "")
    .replace(/[\s()[\]\-·.,_'"]/g, "");

/** "파크리오 101동" → ["파크리오", "101"], "제5동" → ["", "5"], 숫자로 안 끝나면 [이름, null] */
function splitLabel(s: unknown): [string, string | null] {
  const t = String(s ?? "").trim();
  const m = t.match(/^(.*?)[\s(]*제?\s*(\d+)\s*동?\)?$/);
  return m ? [norm(m[1]), String(Number(m[2]))] : [norm(t), null];
}

/** 대장 동 표기 — "112동" / "제112동" / "112"만 (그 밖은 null) */
function ledgerDongNo(s: unknown): string | null {
  const m = String(s ?? "").replace(/\s/g, "").match(/^제?(\d+)동?$/);
  return m ? String(Number(m[1])) : null;
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const ci = process.argv.indexOf("--complex");
  const onlyComplex = ci > 0 ? process.argv[ci + 1] : null;
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음 (.env.local)");
  mkdirSync(OUT, { recursive: true });
  const planPath = join(OUT, onlyComplex ? `plan-${onlyComplex}.json` : "plan.json");

  if (apply) {
    if (!existsSync(planPath)) throw new Error("먼저 --apply 없이 돌려 계획 파일을 만드세요.");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { links: Link[] };
    let updated = 0;
    for (const part of chunks(plan.links, 200)) {
      const res = await db.batch(
        part.map((l) => ({
          sql: `UPDATE gis_buildings SET bldrgst_pk = ? WHERE bld_key = ? AND bldrgst_pk IS NULL`,
          args: [l.new_bldrgst_pk, l.bld_key],
        })),
        "write",
      );
      updated += res.reduce((s, r) => s + r.rowsAffected, 0);
    }
    console.log(JSON.stringify({ mode: "apply", planned: plan.links.length, updated }));
    return;
  }

  // 1) 번호 없는 GIS 행
  const gis = (
    await db.execute(
      `SELECT bld_key, lawd_cd, name, dong_name, floors_above, lat, lng FROM gis_buildings
       WHERE bldrgst_pk IS NULL AND rings IS NOT NULL AND rings <> 'null'`,
    )
  ).rows;
  const lawds = [...new Set(gis.map((g) => String(g.lawd_cd)))];

  // 2) 같은 시군구 단지 좌표 (지도 기준점 우선 — read.ts와 같음)
  const masters: Array<Record<string, unknown>> = [];
  for (const part of chunks(lawds, 100)) {
    const r = await db.execute({
      sql: `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd,
                   COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
            FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
            WHERE m.lawd_cd IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    masters.push(...r.rows.filter((x) => x.lat != null));
  }

  // GIS 행마다 1km 안 같은 시군구 단지
  const nearCx = new Map<string, Array<{ m: Record<string, unknown>; d: number }>>();
  const cxIds = new Set<string>();
  for (const g of gis) {
    const list = masters
      .filter((m) => m.lawd_cd === g.lawd_cd)
      .map((m) => ({ m, d: haversine(Number(m.lat), Number(m.lng), Number(g.lat), Number(g.lng)) }))
      .filter((x) => x.d <= LINK_MAX_M);
    nearCx.set(String(g.bld_key), list);
    for (const x of list) cxIds.add(String(x.m.complex_id));
  }

  // 3) 그 단지들의 동
  const cbByCx = new Map<string, Array<Record<string, unknown>>>();
  for (const part of chunks([...cxIds], 200)) {
    const r = await db.execute({
      sql: `SELECT complex_id, building_id, mgm_bldrgst_pk, dong_label, building_name, floor_count
            FROM complex_buildings WHERE complex_id IN (${part.map(() => "?").join(",")}) AND length(mgm_bldrgst_pk) > 5`,
      args: part,
    });
    for (const b of r.rows) {
      const k = String(b.complex_id);
      (cbByCx.get(k) ?? cbByCx.set(k, []).get(k)!).push(b);
    }
  }

  // 4) 후보 짝
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const floorMismatch: unknown[] = [];
  const cand: Link[] = [];
  for (const g of gis) {
    const [pn, nn] = splitLabel(g.name);
    const [pd, nd] = splitLabel(g.dong_name);
    if (nn && nd && nn !== nd) {
      skip("gis_name_dong_disagree");
      continue;
    }
    const no = nd ?? nn;
    const prefixes = new Set([pn, pd].filter((p) => p && p.length >= 2));
    if (!no || !prefixes.size) {
      skip("gis_label_not_name+number");
      continue;
    }
    const hits: Link[] = [];
    for (const { m, d } of nearCx.get(String(g.bld_key)) ?? []) {
      const cxNames = [norm(m.apt_name), norm(m.apt_name_norm)];
      for (const b of cbByCx.get(String(m.complex_id)) ?? []) {
        if (ledgerDongNo(b.dong_label) !== no) continue;
        const names = new Set([...cxNames, norm(b.building_name)].filter(Boolean));
        if (![...prefixes].some((p) => names.has(p))) continue;
        hits.push({
          bld_key: String(g.bld_key),
          new_bldrgst_pk: String(b.mgm_bldrgst_pk).slice(5),
          complex_id: String(m.complex_id),
          apt_name: String(m.apt_name),
          building_id: String(b.building_id),
          dong_label: String(b.dong_label),
          gis_label: `${g.name ?? ""} / ${g.dong_name ?? ""}`,
          floors_gis: num(g.floors_above),
          floors_ledger: num(b.floor_count),
          dist_m: Math.round(d),
        });
      }
    }
    if (!hits.length) {
      skip("no_exact_name+dong_building");
      continue;
    }
    if (hits.length > 1) {
      skip("gis_row_matches_2+_buildings");
      continue;
    }
    const h = hits[0]!;
    if (h.floors_gis && h.floors_ledger && Math.abs(h.floors_gis - h.floors_ledger) > FLOOR_TOL) {
      skip("floor_count_differs");
      floorMismatch.push(h);
      continue;
    }
    cand.push(h);
  }

  // 동 하나에 GIS 행 둘 이상 → 모두 건너뜀
  const perBuilding = new Map<string, number>();
  for (const c of cand) perBuilding.set(c.building_id, (perBuilding.get(c.building_id) ?? 0) + 1);
  let links = cand.filter((c) => {
    if (perBuilding.get(c.building_id)! > 1) {
      skip("building_matched_by_2+_gis_rows");
      return false;
    }
    return true;
  });

  // 5) 이미 모양이 있는 동(같은 시군구·같은 번호 GIS 행이 단지 1km 안)은 건드리지 않는다 — 빈 것만 채움
  const mById = new Map(masters.map((m) => [String(m.complex_id), m]));
  const existing = new Map<string, Array<Record<string, unknown>>>();
  for (const part of chunks([...new Set(links.map((l) => l.new_bldrgst_pk))], 200)) {
    const r = await db.execute({
      sql: `SELECT bldrgst_pk, lawd_cd, lat, lng FROM gis_buildings WHERE bldrgst_pk IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const x of r.rows) {
      const k = `${x.lawd_cd}|${x.bldrgst_pk}`;
      (existing.get(k) ?? existing.set(k, []).get(k)!).push(x);
    }
  }
  links = links.filter((l) => {
    const m = mById.get(l.complex_id)!;
    const ex = existing.get(`${m.lawd_cd}|${l.new_bldrgst_pk}`) ?? [];
    if (ex.some((x) => haversine(Number(m.lat), Number(m.lng), Number(x.lat), Number(x.lng)) <= LINK_MAX_M)) {
      skip("building_already_has_gis_row");
      return false;
    }
    return true;
  });

  // 한 단지만: 모호함 검사는 전체 단지로 한 뒤 결과만 좁힌다
  if (onlyComplex) links = links.filter((l) => l.complex_id === onlyComplex);

  const byComplex: Record<string, number> = {};
  for (const l of links) byComplex[`${l.apt_name} ${l.complex_id}`] = (byComplex[`${l.apt_name} ${l.complex_id}`] ?? 0) + 1;
  writeFileSync(
    planPath,
    JSON.stringify({ built_at: new Date().toISOString(), gis_null_rows: gis.length, links, skipped, floorMismatch, byComplex }, null, 1),
  );
  console.log(JSON.stringify({ mode: "dry-run", gis_null_rows: gis.length, links: links.length, complexes: Object.keys(byComplex).length, skipped, plan: planPath }, null, 1));
  console.log(byComplex);
  const sample = [...links].sort(() => Math.random() - 0.5).slice(0, 20);
  for (const s of sample)
    console.log(`${s.apt_name} ${s.dong_label} (${s.floors_ledger}F) ← GIS "${s.gis_label}" (${s.floors_gis}F) ${s.dist_m}m pk=${s.new_bldrgst_pk}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
