/**
 * 단지 동 모양 빈틈 채우기 — data/building-coverage/PLAN.md C절의 엄격한(빈 것만) 후보를 적용한다.
 * 후보: data/building-coverage/b-fill-candidates.json (GIS, R1/R2) + b-fill-candidates-spbd.json (브이월드 SPBD, R3) — b-audit.mts가 만든 것.
 *
 * 붙이는 방식 (더하기만 — 기존 행은 안 바꾼다):
 *   LINK_TO_CB   모양 없는 대장 동(complex_buildings) ↔ 도형 1:1. SPBD 도형은 gis_buildings에 새 행
 *                (bld_key 'SPBD:'+건물관리번호, change_type 'SPBD', bldrgst_pk = 대장번호 뒤쪽, lawd_cd = 단지 시군구)을 INSERT OR IGNORE.
 *                → read.ts의 번호 연결로 그대로 붙는다. (GIS 원천 LINK 후보가 있으면 bldrgst_pk가 NULL일 때만 UPDATE)
 *   EXTRA_SHAPE  대장 행이 없는 단지 건물 → complex_extra_shapes에 INSERT OR IGNORE (외곽선·층수·높이·근거 복사).
 *                SPBD 도형은 주변 건물·타일에도 보이게 gis_buildings에도 새 행(bldrgst_pk NULL)으로 넣는다.
 *
 * 적용 전 다시 확인(라이브 DB) — 걸리면 계획에서 빼고 anomalies로 보고, apply는 anomalies가 있으면 멈춘다:
 *   - 대장 동이 아직 모양이 없는지(같은 시군구·번호 GIS 행이 단지 1km 안에 하나도 없음), 그 번호를 1km 안 다른 단지가 같이 쓰지 않는지
 *   - 이미 그려진 건물(어느 단지 동에 연결된 GIS 행 · SPBD 행 · complex_extra_shapes)이나 다른 후보와 10% 넘게 겹치지 않는지
 *   - EXTRA GIS 행이 다른 단지 동에 번호로 연결돼 있지 않은지, 같은 도형이 두 단지에 가지 않는지
 *
 *   npx tsx scripts/building-coverage/apply-fill.mts             # dry-run → data/building-coverage/apply-plan.json (DB 쓰기 없음)
 *   npx tsx scripts/building-coverage/apply-fill.mts --apply     # 계획대로 넣기 (다시 dry-run 하면 할 일 0)
 *   SPBD 도형은 처음 한 번 data/building-coverage/cache/spbd-seoul.json(spbd-index.mts, 263MB)에서 b-fill-spbd-shapes.json으로 뽑아 둔다
 *   (--spbd-cache=<path>; 큰 파일이라 NODE_OPTIONS=--max-old-space-size=6144).
 * 되돌리기: DELETE FROM complex_extra_shapes; DELETE FROM gis_buildings WHERE bld_key IN (계획 파일의 gis_inserts).
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";

type Pt = [number, number];
type Rings = Pt[][];
type Cand = {
  complex_id: string;
  apt: string;
  kind: "LINK_TO_CB" | "EXTRA_SHAPE";
  rule: string;
  src: "gis" | "spbd";
  shape: Record<string, unknown> & { bld_key: string; name?: string; dong?: string; fl?: number | null };
  area_m2: number;
  cb: { building_id: string; pk: string; dong: string | null; name: string | null; fl: number | null } | null;
  complex: Record<string, unknown>;
};
type SpbdFeature = { bd_mgt_sn: string; buld_nm: string; buld_nm_dc: string; gro_flo_co: number | null; lat: number; lng: number; rings: Rings };

const DIR = "data/building-coverage";
const PLAN = `${DIR}/apply-plan.json`;
const SHAPES = `${DIR}/b-fill-spbd-shapes.json`;
const MIGRATION = "src/lib/db/migrations/20261004_complex_extra_shapes.sql";
const LINK_MAX_M = 1000; // read.ts A_LINK_MAX_M
const OVERLAP_MAX = 0.1; // 작은 쪽 넓이의 10% 넘게 겹치면 이상
const NONRES = /상가|관리|경로|노인정|근린|전기|발전|어린이집|주민공동|부대|복리|생활지원|오피스텔|경비/;

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const apply = args.includes("--apply");

const db = getDb();
if (!db) throw new Error("DB 설정 없음 (.env.local)");
const q = async (sql: string, a: Array<string | number | null> = []) => (await db.execute({ sql, args: a })).rows;
const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function haversine(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, d = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(d(bLat - aLat) / 2) ** 2 + Math.cos(d(aLat)) * Math.cos(d(bLat)) * Math.sin(d(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inRing([x, y]: Pt, ring: Pt[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inShape = (p: Pt, rs: Rings) => rs.some((r) => inRing(p, r));
function bbox(rs: Rings): [number, number, number, number] {
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rs) for (const [x, y] of r) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}
function areaM2(rs: Rings) {
  let s = 0;
  for (const r of rs) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
    s += Math.abs(a / 2) * 111320 * 111320 * Math.cos((r[0]![1] * Math.PI) / 180);
  }
  return s;
}
/** 겹친 넓이 / 작은 쪽 넓이 — 두 겉상자가 겹친 곳에 40×40 점을 찍어 센다 */
function overlapFrac(a: Rings, b: Rings): number {
  const [ax0, ay0, ax1, ay1] = bbox(a);
  const [bx0, by0, bx1, by1] = bbox(b);
  const x0 = Math.max(ax0, bx0), y0 = Math.max(ay0, by0), x1 = Math.min(ax1, bx1), y1 = Math.min(ay1, by1);
  if (x0 >= x1 || y0 >= y1) return 0;
  const N = 40;
  let both = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p: Pt = [x0 + ((i + 0.5) * (x1 - x0)) / N, y0 + ((j + 0.5) * (y1 - y0)) / N];
      if (inShape(p, a) && inShape(p, b)) both++;
    }
  if (!both) return 0;
  const inter = (both / (N * N)) * (x1 - x0) * (y1 - y0) * 111320 * 111320 * Math.cos((y0 * Math.PI) / 180);
  return inter / Math.min(areaM2(a), areaM2(b));
}
/** 넓이 가중 중심 (가장 큰 외곽선) — fill-gis-from-vworld-spbd.mts와 같음 */
function centroid(rings: Rings): { lat: number; lng: number } {
  let best: { a: number; x: number; y: number } | null = null;
  for (const ring of rings) {
    const [ox, oy] = ring[0]!;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const x0 = ring[i]![0] - ox, y0 = ring[i]![1] - oy, x1 = ring[i + 1]![0] - ox, y1 = ring[i + 1]![1] - oy;
      const f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    }
    if (a === 0) continue;
    const c = { a: Math.abs(a / 2), x: ox + cx / (3 * a), y: oy + cy / (3 * a) };
    if (!best || c.a > best.a) best = c;
  }
  if (!best) return { lat: rings[0]![0]![1], lng: rings[0]![0]![0] };
  return { lat: Math.round(best.y * 1e7) / 1e7, lng: Math.round(best.x * 1e7) / 1e7 };
}

// ── 후보 + 도형 ─────────────────────────────────────────────
const cands: Cand[] = [
  ...(JSON.parse(readFileSync(`${DIR}/b-fill-candidates.json`, "utf8")) as Cand[]),
  ...(JSON.parse(readFileSync(`${DIR}/b-fill-candidates-spbd.json`, "utf8")) as Cand[]),
];
const spbdKeys = new Set(cands.filter((c) => c.src === "spbd").map((c) => c.shape.bld_key.replace(/^SPBD:/, "")));
if (!existsSync(SHAPES)) {
  const cachePath = arg("spbd-cache") ?? [`${DIR}/cache/spbd-seoul.json`, `C:/dev/ziplab/${DIR}/cache/spbd-seoul.json`].find(existsSync);
  if (!cachePath) throw new Error("SPBD 캐시 없음 — --spbd-cache=<spbd-seoul.json>");
  const all = JSON.parse(readFileSync(cachePath, "utf8")) as SpbdFeature[];
  writeFileSync(SHAPES, JSON.stringify(all.filter((f) => spbdKeys.has(f.bd_mgt_sn))));
  console.log(`SPBD 도형 ${spbdKeys.size}개 뽑음 → ${SHAPES}`);
}
const spbdByKey = new Map((JSON.parse(readFileSync(SHAPES, "utf8")) as SpbdFeature[]).map((f) => [`SPBD:${f.bd_mgt_sn}`, f]));

type Item = {
  kind: Cand["kind"];
  complex_id: string;
  apt: string;
  rule: string;
  src: "GIS" | "SPBD";
  bld_key: string;
  cb_building_id: string | null;
  bldrgst_pk: string | null; // LINK: 대장번호 뒤쪽
  lawd_cd: string;
  name: string | null;
  dong: string | null;
  residential: 0 | 1;
  floors: number | null;
  height_m: number | null;
  approval_date: string | null;
  lat: number;
  lng: number;
  rings: Rings;
  evidence: Record<string, unknown>;
  todo: { gis_insert: boolean; gis_update_pk: boolean; extra_insert: boolean };
};

async function plan() {
  // 라이브 DB 읽기 (쓰기 없음)
  const master = await q(`SELECT m.complex_id, m.lawd_cd, COALESCE(a.lat, m.latitude) lat, COALESCE(a.lng, m.longitude) lng
    FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id WHERE m.lawd_cd LIKE '11%'`);
  const cx = new Map(master.map((m) => [String(m.complex_id), { lawd: String(m.lawd_cd), lat: Number(m.lat), lng: Number(m.lng) }]));
  const cbRows = await q(`SELECT complex_id, building_id, mgm_bldrgst_pk, dong_label, floor_count FROM complex_buildings
    WHERE complex_id IN (SELECT complex_id FROM apt_complex_master WHERE lawd_cd LIKE '11%') AND length(mgm_bldrgst_pk) > 5`);
  const cbById = new Map(cbRows.map((r) => [String(r.building_id), r]));
  /** lawd|번호뒤쪽 → 그 번호를 쓰는 단지들 */
  const cbKey = new Map<string, string[]>();
  for (const r of cbRows) {
    const m = cx.get(String(r.complex_id));
    if (!m) continue;
    const k = `${m.lawd}|${String(r.mgm_bldrgst_pk).slice(5)}`;
    (cbKey.get(k) ?? cbKey.set(k, []).get(k)!).push(String(r.complex_id));
  }
  const linkedTo = (lawd: unknown, pk: unknown, lat: number, lng: number) =>
    pk == null ? [] : (cbKey.get(`${lawd}|${pk}`) ?? []).filter((cid) => {
      const m = cx.get(cid)!;
      return !Number.isFinite(lat) || haversine(m.lat, m.lng, lat, lng) <= LINK_MAX_M;
    });

  const extraTable = (await q(`SELECT name FROM sqlite_master WHERE type='table' AND name='complex_extra_shapes'`)).length > 0;
  const extraRows = extraTable ? await q(`SELECT complex_id, bld_key, rings FROM complex_extra_shapes`) : [];
  const extraHave = new Set(extraRows.map((r) => `${r.complex_id}|${r.bld_key}`));
  const extraOwner = new Map(extraRows.map((r) => [String(r.bld_key), String(r.complex_id)]));

  const keys = cands.map((c) => c.shape.bld_key);
  const gisHave = new Map<string, Record<string, unknown>>();
  for (const part of chunks(keys, 300)) {
    for (const r of await q(`SELECT bld_key, bldrgst_pk, lawd_cd, name, dong_name, floors_above, height_m, approval_date, lat, lng, rings, change_type
      FROM gis_buildings WHERE bld_key IN (${part.map(() => "?").join(",")})`, part)) gisHave.set(String(r.bld_key), r);
  }

  const anomalies: Array<Record<string, unknown>> = [];
  const info: Record<string, number> = {};
  const bump = (k: string) => (info[k] = (info[k] ?? 0) + 1);
  const items: Item[] = [];
  const bad = (c: Cand, why: string, extra: Record<string, unknown> = {}) =>
    anomalies.push({ why, complex_id: c.complex_id, apt: c.apt, kind: c.kind, rule: c.rule, bld_key: c.shape.bld_key, ...extra });

  // 같은 도형·같은 대장 동이 두 번 나오면 이상
  const dupShape = new Map<string, number>();
  const dupCb = new Map<string, number>();
  for (const c of cands) {
    dupShape.set(c.shape.bld_key, (dupShape.get(c.shape.bld_key) ?? 0) + 1);
    if (c.cb) dupCb.set(c.cb.building_id, (dupCb.get(c.cb.building_id) ?? 0) + 1);
  }

  // LINK: 같은 번호 GIS 행 (라이브)
  const linkCands = cands.filter((c) => c.kind === "LINK_TO_CB");
  const pkRows = new Map<string, Array<Record<string, unknown>>>();
  for (const part of chunks(linkCands, 100)) {
    const res = await db!.batch(
      part.map((c) => ({
        sql: `SELECT bld_key, lat, lng, (rings IS NOT NULL AND rings <> 'null') has FROM gis_buildings WHERE lawd_cd = ? AND bldrgst_pk = ?`,
        args: [cx.get(c.complex_id)?.lawd ?? "", String(c.cb?.pk ?? "").slice(5)],
      })),
      "read",
    );
    part.forEach((c, i) => pkRows.set(c.shape.bld_key, res[i]!.rows as unknown as Array<Record<string, unknown>>));
  }

  for (const c of cands) {
    const m = cx.get(c.complex_id);
    if (!m) { bad(c, "complex_not_in_seoul_master"); continue; }
    if (dupShape.get(c.shape.bld_key)! > 1) { bad(c, "shape_in_2+_candidates"); continue; }
    if (c.cb && dupCb.get(c.cb.building_id)! > 1) { bad(c, "cb_in_2+_candidates"); continue; }
    const have = gisHave.get(c.shape.bld_key);
    let rings: Rings, lat: number, lng: number, name: string | null, dong: string | null, floors: number | null, height: number | null, appr: string | null;
    if (c.src === "spbd") {
      const f = spbdByKey.get(c.shape.bld_key);
      if (!f) { bad(c, "spbd_geometry_missing"); continue; }
      rings = f.rings; ({ lat, lng } = centroid(f.rings));
      name = f.buld_nm || null; dong = f.buld_nm_dc || null; floors = numOrNull(f.gro_flo_co); height = null; appr = null;
      if (floors != null && floors <= 0) floors = null;
    } else {
      if (!have || !have.rings || have.rings === "null") { bad(c, "gis_row_missing"); continue; }
      rings = JSON.parse(String(have.rings)) as Rings; lat = Number(have.lat); lng = Number(have.lng);
      name = (have.name as string) || null; dong = (have.dong_name as string) || null;
      floors = numOrNull(have.floors_above); height = numOrNull(have.height_m); appr = (have.approval_date as string) || null;
    }
    if (haversine(m.lat, m.lng, lat, lng) > LINK_MAX_M) { bad(c, "shape_over_1km_from_complex"); continue; }
    const todo = { gis_insert: false, gis_update_pk: false, extra_insert: false };
    let pk: string | null = null;

    if (c.kind === "LINK_TO_CB") {
      const b = c.cb ? cbById.get(c.cb.building_id) : undefined;
      if (!b || String(b.complex_id) !== c.complex_id || String(b.mgm_bldrgst_pk) !== String(c.cb!.pk)) { bad(c, "cb_row_changed_or_missing"); continue; }
      pk = String(b.mgm_bldrgst_pk).slice(5);
      const near = (pkRows.get(c.shape.bld_key) ?? []).filter(
        (g) => !Number.isFinite(Number(g.lat)) || haversine(m.lat, m.lng, Number(g.lat), Number(g.lng)) <= LINK_MAX_M,
      );
      const others = near.filter((g) => String(g.bld_key) !== c.shape.bld_key);
      if (others.length) { bad(c, "cb_already_has_gis_row_within_1km", { rows: others.map((g) => g.bld_key) }); continue; }
      const sharers = linkedTo(m.lawd, pk, lat, lng).filter((cid) => cid !== c.complex_id);
      if (sharers.length) { bad(c, "pk_shared_by_other_complex_within_1km", { sharers }); continue; }
      const ledgerFl = numOrNull(b.floor_count);
      if (c.src === "spbd" && floors === 1 && ledgerFl != null && ledgerFl >= 3) { floors = null; bump("spbd_floor_placeholder_1_to_null"); }
      if (c.src === "spbd") {
        if (have) {
          if (String(have.bldrgst_pk ?? "") !== pk || String(have.lawd_cd) !== m.lawd) { bad(c, "spbd_row_exists_with_other_link", { pk: have.bldrgst_pk }); continue; }
        } else todo.gis_insert = true;
      } else {
        if (have!.bldrgst_pk == null) todo.gis_update_pk = true;
        else if (String(have!.bldrgst_pk) !== pk) { bad(c, "gis_row_has_other_pk", { pk: have!.bldrgst_pk }); continue; }
      }
    } else {
      // EXTRA
      const owner = extraOwner.get(c.shape.bld_key);
      if (owner && owner !== c.complex_id) { bad(c, "extra_shape_owned_by_other_complex", { owner }); continue; }
      if (c.src === "gis") {
        const users = linkedTo(have!.lawd_cd, have!.bldrgst_pk, lat, lng);
        if (users.length) { bad(c, "gis_row_linked_to_complex_building", { users }); continue; }
      } else if (have) {
        if (have.bldrgst_pk != null) { bad(c, "spbd_row_exists_linked", { pk: have.bldrgst_pk }); continue; }
      } else todo.gis_insert = true;
      if (!extraHave.has(`${c.complex_id}|${c.shape.bld_key}`)) todo.extra_insert = true;
    }
    // 부속 건물(상가·관리동·경로당 …)은 강조하지 않게 비주거로 — 동 표기로만 판단 (LINK는 대장 주용도를 그대로 쓴다)
    const label = dong ?? "";
    items.push({
      kind: c.kind, complex_id: c.complex_id, apt: c.apt, rule: c.rule, src: c.src === "spbd" ? "SPBD" : "GIS",
      bld_key: c.shape.bld_key, cb_building_id: c.cb?.building_id ?? null, bldrgst_pk: pk, lawd_cd: m.lawd,
      name, dong, residential: NONRES.test(label) ? 0 : 1, floors, height_m: height, approval_date: appr,
      lat, lng, rings,
      evidence: { rule: c.rule, src: c.src, shape: c.shape, area_m2: c.area_m2, cb: c.cb, complex: c.complex },
      todo,
    });
  }

  // 겹침: 이미 그려진 건물(어느 단지 동에 연결된 GIS 행 · SPBD 행 · 다른 단지 EXTRA) + 후보끼리
  const planKeys = new Set(items.map((i) => i.bld_key));
  const nearStmts = items.map((it) => {
    const [x0, y0, x1, y1] = bbox(it.rings);
    const d = 0.0015;
    return { sql: `SELECT bld_key, bldrgst_pk, lawd_cd, change_type, lat, lng, rings FROM gis_buildings WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`, args: [y0 - d, y1 + d, x0 - d, x1 + d] };
  });
  const overlapOut = new Set<string>();
  const minor: Array<Record<string, unknown>> = [];
  let k = 0;
  for (const part of chunks(nearStmts, 40)) {
    const res = await db!.batch(part, "read");
    for (const r of res) {
      const it = items[k++]!;
      for (const g of r.rows) {
        const key = String(g.bld_key);
        if (planKeys.has(key)) continue; // 자기 자신·다른 후보(아래에서 따로)·이미 넣은 행
        const drawn = g.change_type === "SPBD" ? "SPBD" : linkedTo(g.lawd_cd, g.bldrgst_pk, Number(g.lat), Number(g.lng)).length ? "linked" : extraOwner.has(key) ? "extra" : null;
        if (!drawn) continue;
        const f = overlapFrac(it.rings, JSON.parse(String(g.rings)) as Rings);
        if (f > OVERLAP_MAX) {
          overlapOut.add(it.bld_key);
          anomalies.push({ why: "overlaps_drawn_building", complex_id: it.complex_id, apt: it.apt, kind: it.kind, rule: it.rule, bld_key: it.bld_key, other: key, other_kind: drawn, frac: +f.toFixed(2), linked_complexes: linkedTo(g.lawd_cd, g.bldrgst_pk, Number(g.lat), Number(g.lng)) });
        } else if (f > 0) minor.push({ bld_key: it.bld_key, other: key, frac: +f.toFixed(3) });
      }
    }
  }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (Math.abs(a.lat - b.lat) > 0.003 || Math.abs(a.lng - b.lng) > 0.004) continue;
      const f = overlapFrac(a.rings, b.rings);
      if (f > OVERLAP_MAX) {
        overlapOut.add(a.bld_key); overlapOut.add(b.bld_key);
        anomalies.push({ why: "candidates_overlap_each_other", a: `${a.apt} ${a.bld_key}`, b: `${b.apt} ${b.bld_key}`, frac: +f.toFixed(2) });
      } else if (f > 0) minor.push({ bld_key: a.bld_key, other: b.bld_key, frac: +f.toFixed(3) });
    }
  const ok = items.filter((i) => !overlapOut.has(i.bld_key));

  const cnt = (f: (i: Item) => boolean) => ok.filter(f).length;
  const summary = {
    mode: "dry-run",
    candidates: cands.length,
    candidate_complexes: new Set(cands.map((c) => c.complex_id)).size,
    planned: ok.length,
    planned_complexes: new Set(ok.map((i) => i.complex_id)).size,
    by_kind: { LINK_TO_CB: cnt((i) => i.kind === "LINK_TO_CB"), EXTRA_SHAPE: cnt((i) => i.kind === "EXTRA_SHAPE") },
    by_src: { GIS: cnt((i) => i.src === "GIS"), SPBD: cnt((i) => i.src === "SPBD") },
    extra_nonresidential: cnt((i) => i.kind === "EXTRA_SHAPE" && !i.residential),
    todo: {
      gis_insert: cnt((i) => i.todo.gis_insert),
      gis_update_pk: cnt((i) => i.todo.gis_update_pk),
      extra_insert: cnt((i) => i.todo.extra_insert),
      already_done: cnt((i) => !i.todo.gis_insert && !i.todo.gis_update_pk && !i.todo.extra_insert),
    },
    extra_table_exists: extraTable,
    anomalies: anomalies.length,
    anomalies_by_why: anomalies.reduce<Record<string, number>>((s, a) => ((s[String(a.why)] = (s[String(a.why)] ?? 0) + 1), s), {}),
    minor_overlaps_le_10pct: minor.length,
    info,
  };
  writeFileSync(PLAN, JSON.stringify({ built_at: new Date().toISOString(), summary, anomalies, minor, items: ok }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (anomalies.length) console.log(JSON.stringify(anomalies.slice(0, 40), null, 1));
}

async function doApply() {
  if (!existsSync(PLAN)) throw new Error("계획 없음 — 먼저 dry-run");
  const p = JSON.parse(readFileSync(PLAN, "utf8")) as { summary: { anomalies: number }; items: Item[] };
  if (p.summary.anomalies && !args.includes("--skip-anomalies"))
    throw new Error(`anomalies ${p.summary.anomalies}건 — 확인 후 --skip-anomalies로만 적용 (이상 후보는 계획에서 이미 빠져 있음)`);
  for (const stmt of readFileSync(MIGRATION, "utf8").split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean))
    await db!.execute(stmt);
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const cols = ["bld_key", "bldrgst_pk", "pnu", "bjdong_cd", "lawd_cd", "name", "dong_name", "use_code", "use_name", "structure",
    "height_m", "floors_above", "floors_below", "building_area", "total_floor_area", "approval_date", "lat", "lng", "rings", "source_date", "change_type"];
  const stmts: Array<{ sql: string; args: Array<string | number | null> }> = [];
  for (const it of p.items) {
    if (it.todo.gis_insert) {
      const vals: Record<string, string | number | null> = {
        bld_key: it.bld_key, bldrgst_pk: it.kind === "LINK_TO_CB" ? it.bldrgst_pk : null, lawd_cd: it.lawd_cd,
        name: it.name, dong_name: it.dong, floors_above: it.floors, lat: it.lat, lng: it.lng, rings: JSON.stringify(it.rings),
        source_date: day, change_type: "SPBD",
      };
      const hash = createHash("sha1").update(JSON.stringify(cols.map((c) => vals[c] ?? null))).digest("hex");
      stmts.push({
        sql: `INSERT OR IGNORE INTO gis_buildings (${cols.join(", ")}, payload_hash, loaded_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`,
        args: [...cols.map((c) => vals[c] ?? null), hash, now],
      });
    }
    if (it.todo.gis_update_pk)
      stmts.push({ sql: `UPDATE gis_buildings SET bldrgst_pk = ?, lawd_cd = ? WHERE bld_key = ? AND bldrgst_pk IS NULL`, args: [it.bldrgst_pk, it.lawd_cd, it.bld_key] });
    if (it.todo.extra_insert)
      stmts.push({
        sql: `INSERT OR IGNORE INTO complex_extra_shapes (complex_id, bld_key, source, rule, dong_label, name, residential, floors_above, height_m,
                approval_date, lat, lng, rings, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [it.complex_id, it.bld_key, it.src, it.rule, it.dong, it.name, it.residential, it.floors, it.height_m, it.approval_date,
          it.lat, it.lng, JSON.stringify(it.rings), JSON.stringify(it.evidence), now],
      });
  }
  let affected = 0;
  for (const part of chunks(stmts, 150)) {
    const t0 = Date.now();
    const res = await db!.batch(part, "write");
    affected += res.reduce((s, r) => s + r.rowsAffected, 0);
    if (Date.now() - t0 > 5000) {
      console.log(JSON.stringify({ stopped: "batch > 5s", statements: stmts.length, affected }));
      return;
    }
    await sleep(500);
  }
  console.log(JSON.stringify({ mode: "apply", statements: stmts.length, affected }, null, 1));
}

await (apply ? doApply() : plan());
