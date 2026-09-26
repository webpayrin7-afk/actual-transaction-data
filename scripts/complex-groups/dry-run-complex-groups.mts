/* eslint-disable @typescript-eslint/no-explicit-any -- 읽기 전용 분석 스크립트 (dry-run 결과 JSON 을 자유 모양으로 만든다) */
/**
 * 단지 묶음(complex group) DRY-RUN — 읽기 전용. DB에 쓰지 않는다.
 *
 * 국토부 실거래 원자료는 한 단지를 지번별로 쪼개 이름 끝에 "(24-0)", "(24-1)"을 붙인다.
 * 같은 lawd_cd + 같은 bjdong_cd + 같은 기본이름(끝 괄호 지번 뗀 이름) 2건 이상 = 후보 묶음.
 * 증거(엄격)만으로 CONFIRMED / LIKELY / DIFFERENT 를 나눈다. 추정·유사 매칭 없음.
 *
 *   npx tsx scripts/complex-groups/dry-run-complex-groups.mts
 * 출력: data/complex-groups/dry-run-<date>.json, data/complex-groups/dry-run-<date>.md
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { writeFileSync, mkdirSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";

const db = getDb();
if (!db) throw new Error("no db");

const DATE = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
const LOT_RE = /\s*\((\d+(?:-\d+)?)\)\s*$/;
const NEAR_M = 150;
const FAR_M = 400;
const APPROVAL_FAR_DAYS = 365 * 2;

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? null : String(v));
const n = (v: unknown) => (v == null || v === "" ? null : Number(v));

async function inChunks<T>(ids: string[], size: number, fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}
const ph = (k: number) => Array(k).fill("?").join(",");

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function parseLot(j: string | null): { bon: number; bu: number } | null {
  if (!j) return null;
  const m = /^(?:산\s*)?(\d+)(?:-(\d+))?$/.exec(j.trim());
  return m ? { bon: Number(m[1]), bu: m[2] ? Number(m[2]) : 0 } : null;
}
function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
}

// ── 1. 후보 묶음 ─────────────────────────────────────────────
const master = (
  await db.execute(
    `SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, legal_dong_name, sigungu, jibun, latitude, longitude, identity_status FROM apt_complex_master`,
  )
).rows;

const byKey = new Map<string, Row[]>();
const byLawdBase = new Map<string, Row[]>();
for (const r of master) {
  const base = String(r.apt_name).replace(LOT_RE, "").trim() || String(r.apt_name);
  (r as any).__base = base;
  const k = `${r.lawd_cd}|${r.bjdong_cd ?? "∅"}|${base}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k)!.push(r);
  const k2 = `${r.lawd_cd}|${base}`;
  if (!byLawdBase.has(k2)) byLawdBase.set(k2, []);
  byLawdBase.get(k2)!.push(r);
}
const candidates = [...byKey.entries()].filter(
  ([, v]) => v.length > 1 && v.some((r) => LOT_RE.test(String(r.apt_name))),
);
const nullBjdong = candidates.filter(([k]) => k.split("|")[1] === "∅");
// 참고: lawd+기본이름만 같은(법정동 다름) 묶음 수 — 과제 설명의 ~279와 비교용
const lawdOnlyGroups = [...byLawdBase.values()].filter(
  (v) => v.length > 1 && v.some((r) => LOT_RE.test(String(r.apt_name))),
);
const lawdOnlyCrossDong = lawdOnlyGroups.filter((v) => new Set(v.map((r) => r.bjdong_cd)).size > 1);

const ids = candidates.flatMap(([, v]) => v.map((r) => String(r.complex_id)));
console.log({ master: master.length, candidates: candidates.length, members: ids.length, lawdOnlyGroups: lawdOnlyGroups.length });

// ── 2. 증거 데이터 (IN 목록 배치 읽기) ───────────────────────
const links = await inChunks(ids, 300, async (c) =>
  (await db.execute({ sql: `SELECT source, source_key, complex_id FROM apt_complex_source_links WHERE complex_id IN (${ph(c.length)})`, args: c })).rows,
);
const profile = await inChunks(ids, 300, async (c) =>
  (
    await db.execute({
      sql: `SELECT complex_id, household_count, building_count, approval_date, source,
                   json_extract(raw_meta_json,'$.source_key') AS kapt_key,
                   json_extract(raw_meta_json,'$.field_provenance.approval_date.source') AS appr_src,
                   json_extract(raw_meta_json,'$.field_provenance.household_count.source') AS hh_src
            FROM apt_complex_profile WHERE complex_id IN (${ph(c.length)})`,
      args: c,
    })
  ).rows,
);
const buildings = await inChunks(ids, 300, async (c) =>
  (
    await db.execute({
      sql: `SELECT b.complex_id, b.building_id, b.mgm_bldrgst_pk, b.building_name, b.dong_label, b.residential_flag,
                   b.household_count, b.floor_count, g.centroid_lat, g.centroid_lng, g.geometry_status
            FROM complex_buildings b LEFT JOIN complex_building_geometry g ON g.building_id = b.building_id
            WHERE b.complex_id IN (${ph(c.length)})`,
      args: c,
    })
  ).rows,
);
const checkpoint = await inChunks(ids, 300, async (c) =>
  (await db.execute({ sql: `SELECT complex_id, pnu, parcel_key FROM complex_building_checkpoint WHERE complex_id IN (${ph(c.length)})`, args: c })).rows,
);
const anchor3d = await inChunks(ids, 300, async (c) =>
  (await db.execute({ sql: `SELECT complex_id, lat, lng FROM complex_3d_anchor WHERE complex_id IN (${ph(c.length)})`, args: c })).rows,
);
const mapAnchor = await inChunks(ids, 300, async (c) =>
  (await db.execute({ sql: `SELECT complex_id, lat, lng, matched_road FROM complex_map_anchor WHERE complex_id IN (${ph(c.length)})`, args: c })).rows,
);

// GIS 건물 외곽선 (3D와 같은 연결: 같은 시군구 + 건축물대장 번호 뒤쪽)
const gis = await inChunks(ids, 150, async (c) =>
  (
    await db.execute({
      sql: `SELECT b.complex_id, b.building_id, g.approval_date, g.lat, g.lng, g.rings
            FROM complex_buildings b
            JOIN apt_complex_master m ON m.complex_id = b.complex_id
            JOIN gis_buildings g ON g.lawd_cd = m.lawd_cd AND g.bldrgst_pk = substr(b.mgm_bldrgst_pk, 6)
            WHERE b.complex_id IN (${ph(c.length)}) AND length(b.mgm_bldrgst_pk) > 5`,
      args: c,
    })
  ).rows,
);

// 실거래 건수 (lawd_cd, apt_name_norm) — idx_tx_lawd_apt_ym 사용
const byLawd = new Map<string, Set<string>>();
for (const r of master) {
  if (!ids.includes(String(r.complex_id))) continue;
}
const idSet = new Set(ids);
const txNames = new Map<string, Set<string>>(); // lawd -> names (master norm + MOLIT link names)
for (const r of master) {
  if (!idSet.has(String(r.complex_id))) continue;
  const l = String(r.lawd_cd);
  if (!txNames.has(l)) txNames.set(l, new Set());
  txNames.get(l)!.add(String(r.apt_name_norm));
}
for (const l of links) {
  if (l.source !== "MOLIT") continue;
  const [lawd, ...rest] = String(l.source_key).split("|");
  if (!txNames.has(lawd)) txNames.set(lawd, new Set());
  txNames.get(lawd)!.add(rest.join("|"));
}
const txCount = new Map<string, { trade: number; rent: number; minBy: number | null; maxBy: number | null }>();
for (const [lawd, names] of txNames) {
  const arr = [...names];
  for (let i = 0; i < arr.length; i += 200) {
    const c = arr.slice(i, i + 200);
    const rs = await db.execute({
      sql: `SELECT apt_name_norm, deal_type, count(*) n, min(build_year) mn, max(build_year) mx FROM transactions
            WHERE lawd_cd = ? AND apt_name_norm IN (${ph(c.length)}) GROUP BY apt_name_norm, deal_type`,
      args: [lawd, ...c],
    });
    for (const r of rs.rows) {
      const k = `${lawd}|${r.apt_name_norm}`;
      const cur = txCount.get(k) ?? { trade: 0, rent: 0, minBy: null, maxBy: null };
      if (r.deal_type === "trade") cur.trade += Number(r.n);
      else cur.rent += Number(r.n);
      const mn = n(r.mn), mx = n(r.mx);
      if (mn != null && mn > 0) cur.minBy = cur.minBy == null ? mn : Math.min(cur.minBy, mn);
      if (mx != null && mx > 0) cur.maxBy = cur.maxBy == null ? mx : Math.max(cur.maxBy, mx);
      txCount.set(k, cur);
    }
  }
}
void byLawd;

// complex_id 로 묶이는 주요 표 행 수 (영향 추정용)
const COUNT_TABLES = [
  "complex_buildings",
  "apt_complex_profile",
  "apt_canonical_unit_types",
  "apt_complex_mgmt_fee_monthly",
  "complex_map_anchor",
  "complex_3d_anchor",
  "complex_site_boundary",
  "complex_nearby_schools",
  "complex_building_api_snapshot",
];
const tableCounts: Record<string, Map<string, number>> = {};
for (const t of COUNT_TABLES) {
  tableCounts[t] = new Map();
  const rows = await inChunks(ids, 300, async (c) =>
    (await db.execute({ sql: `SELECT complex_id, count(*) n FROM ${t} WHERE complex_id IN (${ph(c.length)}) GROUP BY complex_id`, args: c })).rows,
  );
  for (const r of rows) tableCounts[t].set(String(r.complex_id), Number(r.n));
}

// ── 3. 멤버별 정리 ───────────────────────────────────────────
const group = <T extends Row>(rows: T[]) => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(r.complex_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
};
const linksBy = group(links), profBy = group(profile), bldBy = group(buildings), cpBy = group(checkpoint);
const a3By = group(anchor3d), maBy = group(mapAnchor), gisBy = group(gis);

type Member = ReturnType<typeof memberOf>;
function memberOf(r: Row) {
  const id = String(r.complex_id);
  const p = profBy.get(id)?.[0];
  const ls = linksBy.get(id) ?? [];
  const kaptLinks = ls.filter((l) => l.source === "KAPT").map((l) => String(l.source_key));
  const kaptProfile = p?.kapt_key && /^A\d+/.test(String(p.kapt_key)) ? String(p.kapt_key) : null;
  const kapt = [...new Set([...kaptLinks, ...(kaptProfile ? [kaptProfile] : [])])];
  const blds = bldBy.get(id) ?? [];
  const res = blds.filter((b) => Number(b.residential_flag) === 1);
  const a3 = a3By.get(id)?.[0];
  const ma = maBy.get(id)?.[0];
  const ref = a3 ?? ma ?? (r.latitude != null ? { lat: r.latitude, lng: r.longitude } : null);
  // 동 외곽선 꼭짓점 (단지 점에서 1km 안만 — 3D 연결 규칙과 같음)
  const pts: [number, number][] = [];
  const gisApproval = new Set<string>();
  for (const g of gisBy.get(id) ?? []) {
    if (ref && haversine([Number(ref.lat), Number(ref.lng)], [Number(g.lat), Number(g.lng)]) > 1000) continue;
    if (g.approval_date) gisApproval.add(String(g.approval_date));
    try {
      const rings = JSON.parse(String(g.rings)) as any;
      const flat: any[] = Array.isArray(rings?.[0]?.[0]?.[0]) ? rings.flat() : rings;
      for (const ring of flat) for (const [x, y] of ring) pts.push([Number(y), Number(x)]);
    } catch {
      pts.push([Number(g.lat), Number(g.lng)]);
    }
  }
  let pointSource = "BUILDING_FOOTPRINT";
  if (!pts.length && a3) { pts.push([Number(a3.lat), Number(a3.lng)]); pointSource = "COMPLEX_3D_ANCHOR"; }
  if (!pts.length && ma) { pts.push([Number(ma.lat), Number(ma.lng)]); pointSource = "MAP_ANCHOR_GEOCODE"; }
  if (!pts.length && r.latitude != null) { pts.push([Number(r.latitude), Number(r.longitude)]); pointSource = "MASTER_POINT"; }
  if (!pts.length) pointSource = "NONE";
  const lawd = String(r.lawd_cd);
  const txNamesFor = new Set([String(r.apt_name_norm)]);
  for (const l of ls) if (l.source === "MOLIT" && String(l.source_key).startsWith(`${lawd}|`)) txNamesFor.add(String(l.source_key).slice(lawd.length + 1));
  let trade = 0, rent = 0, minBy: number | null = null, maxBy: number | null = null;
  for (const nm of txNamesFor) {
    const t = txCount.get(`${lawd}|${nm}`);
    if (!t) continue;
    trade += t.trade; rent += t.rent;
    if (t.minBy != null) minBy = minBy == null ? t.minBy : Math.min(minBy, t.minBy);
    if (t.maxBy != null) maxBy = maxBy == null ? t.maxBy : Math.max(maxBy, t.maxBy);
  }
  const rowCounts: Record<string, number> = {};
  for (const t of COUNT_TABLES) rowCounts[t] = tableCounts[t].get(id) ?? 0;
  return {
    complex_id: id,
    apt_name: String(r.apt_name),
    apt_name_norm: String(r.apt_name_norm),
    jibun: s(r.jibun),
    lot: parseLot(s(r.jibun)),
    name_lot: LOT_RE.exec(String(r.apt_name))?.[1] ?? null,
    pnu: s(cpBy.get(id)?.[0]?.pnu) || null,
    kapt,
    // 공식 단지 총세대(K-apt 기본정보 또는 건축물대장 총괄표제부)일 때만
    // (출처 표시가 없는 옛 행은 K-apt 코드가 붙어 있으면 K-apt 세대로 본다)
    official_households:
      ["KAPT_BASIC_V5", "BUILDING_HUB_RECAP"].includes(String(p?.hh_src)) || (p?.hh_src == null && kapt.length)
        ? n(p?.household_count)
        : null,
    official_hh_src: s(p?.hh_src) ?? (kapt.length && p?.household_count != null ? "KAPT(legacy)" : null),
    kapt_households: kaptProfile || kaptLinks.length ? n(p?.household_count) : null,
    gis_approval_dates: [...gisApproval].sort(),
    profile_households: n(p?.household_count),
    approval_date: s(p?.approval_date),
    approval_src: s(p?.appr_src),
    tx_build_year: minBy == null ? null : minBy === maxBy ? minBy : `${minBy}-${maxBy}`,
    tx_min_by: minBy,
    buildings_total: blds.length,
    buildings_res: res.length,
    res_households_sum: res.reduce((a, b) => a + (n(b.household_count) ?? 0), 0),
    building_names: [...new Set(res.map((b) => s(b.building_name) ?? s(b.dong_label) ?? "?"))].slice(0, 6),
    mgm_bldrgst_pks: res.map((b) => s(b.mgm_bldrgst_pk)).filter(Boolean).slice(0, 10) as string[],
    points: pts,
    point_source: pointSource,
    tx: { trade, rent, names: [...txNamesFor] },
    row_counts: rowCounts,
    identity_status: s(r.identity_status),
  };
}

function minDist(a: Member, b: Member): number | null {
  if (!a.points.length || !b.points.length) return null;
  let best = Infinity;
  for (const p of a.points) for (const q of b.points) best = Math.min(best, haversine(p, q));
  return Math.round(best);
}

// K-apt 세대수 = 멤버 부분집합의 주거동 세대 합 (이 멤버 혼자로는 모자람) → 그 부분집합은 같은 K-apt 단지
function kaptHouseholdSubset(ms: Member[]): { anchor: string; members: string[]; kapt_hh: number }[] {
  const out: { anchor: string; members: string[]; kapt_hh: number }[] = [];
  for (const m of ms) {
    const H = m.official_households;
    if (!H || H < 30) continue; // 작은 수는 우연히 맞을 수 있다
    if (m.res_households_sum === H) continue; // 혼자 이미 맞음 → 다른 멤버 필요 없음
    const others = ms.filter((x) => x !== m && x.res_households_sum > 0);
    if (others.length > 12) continue;
    const hits: string[][] = [];
    for (let mask = 1; mask < 1 << others.length; mask++) {
      let sum = m.res_households_sum;
      const pick: string[] = [];
      others.forEach((o, i) => { if (mask & (1 << i)) { sum += o.res_households_sum; pick.push(o.complex_id); } });
      if (sum === H) hits.push(pick);
    }
    if (hits.length === 1) out.push({ anchor: m.complex_id, members: [m.complex_id, ...hits[0]], kapt_hh: H });
  }
  return out;
}

// ── 4. 짝별 증거 → 묶음 분류 ─────────────────────────────────
type Pair = {
  a: string; b: string;
  strong: string[]; weak: string[]; contra: string[];
  dist_m: number | null; dist_basis: string;
};
const results: any[] = [];
for (const [key, rows] of candidates) {
  const [lawd, bjdong, base] = key.split("|");
  const ms = rows.map(memberOf).sort((x, y) => (x.lot?.bon ?? 1e9) - (y.lot?.bon ?? 1e9) || (x.lot?.bu ?? 0) - (y.lot?.bu ?? 0));
  const hhSubsets = kaptHouseholdSubset(ms);
  const pairs: Pair[] = [];
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i], b = ms[j];
      const strong: string[] = [], weak: string[] = [], contra: string[] = [], hhHit: string[] = [];
      const sharedKapt = a.kapt.filter((k) => b.kapt.includes(k));
      if (sharedKapt.length) strong.push(`SAME_KAPT_CODE:${sharedKapt.join(",")}`);
      else if (a.kapt.length && b.kapt.length) contra.push(`DIFFERENT_KAPT_CODES:${a.kapt.join(",")}≠${b.kapt.join(",")}`);
      if (a.pnu && b.pnu && a.pnu === b.pnu) strong.push(`SAME_PNU:${a.pnu}`);
      const sharedPk = a.mgm_bldrgst_pks.filter((k) => b.mgm_bldrgst_pks.includes(k));
      if (sharedPk.length) strong.push(`SAME_BLDRGST_PK:${sharedPk[0]}`);
      for (const h of hhSubsets)
        if (h.members.includes(a.complex_id) && h.members.includes(b.complex_id))
          hhHit.push(`OFFICIAL_HH_EQUALS_MEMBER_BUILDING_SUM:${h.kapt_hh}(anchor ${h.anchor.slice(-6)})`);
      if (a.lot && b.lot && a.lot.bon === b.lot.bon) weak.push(`SAME_BONBUN:${a.lot.bon}(${a.jibun}/${b.jibun})`);
      else if (a.lot && b.lot && Math.abs(a.lot.bon - b.lot.bon) <= 2) weak.push(`NEAR_BONBUN:${a.jibun}/${b.jibun}`);
      const d = minDist(a, b);
      const basis = a.point_source === "BUILDING_FOOTPRINT" && b.point_source === "BUILDING_FOOTPRINT" ? "footprint" : `${a.point_source}/${b.point_source}`;
      if (d != null && d <= NEAR_M) weak.push(`WITHIN_${NEAR_M}M:${d}m[${basis}]`);
      if (d != null && d > FAR_M) contra.push(`FAR_APART:${d}m[${basis}]`);
      if (a.approval_date && b.approval_date) {
        const dd = dayDiff(a.approval_date, b.approval_date);
        if (dd === 0) weak.push(`SAME_APPROVAL_DATE:${a.approval_date}`);
        else if (dd > APPROVAL_FAR_DAYS) contra.push(`APPROVAL_FAR:${a.approval_date}/${b.approval_date}`);
        else weak.push(`APPROVAL_WITHIN_2Y:${a.approval_date}/${b.approval_date}`);
      } else if (a.gis_approval_dates.length && b.gis_approval_dates.length && a.gis_approval_dates.some((x) => b.gis_approval_dates.includes(x))) {
        weak.push(`SAME_GIS_APPROVAL_DATE:${a.gis_approval_dates.find((x) => b.gis_approval_dates.includes(x))}`);
      } else if (a.tx_min_by && b.tx_min_by && Math.abs(a.tx_min_by - b.tx_min_by) > 2) {
        contra.push(`TX_BUILD_YEAR_FAR:${a.tx_min_by}/${b.tx_min_by}`);
      }
      // 세대 합 증거는 우연 일치를 막으려고 공간 증거(같은 본번 또는 150m 안)가 함께 있을 때만 강한 증거로 센다
      if (hhHit.length) {
        if (weak.some((w) => w.startsWith("SAME_BONBUN") || w.startsWith("WITHIN_"))) strong.push(...hhHit);
        else weak.push(...hhHit.map((x) => `${x}(no-spatial)`));
      }
      pairs.push({ a: a.complex_id, b: b.complex_id, strong, weak, contra, dist_m: d, dist_basis: basis });
    }

  // 강한 증거 + 반대 증거 없음 → union
  const parent = new Map(ms.map((m) => [m.complex_id, m.complex_id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const p of pairs) if (p.strong.length && !p.contra.length) parent.set(find(p.a), find(p.b));
  const comps = new Map<string, string[]>();
  for (const m of ms) {
    const r = find(m.complex_id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(m.complex_id);
  }
  // 강한 묶음 안에 반대 증거 짝이 있으면 묶음 전체 보류
  const confirmedComps = [...comps.values()].filter((c) => c.length > 1).filter((c) =>
    !pairs.some((p) => c.includes(p.a) && c.includes(p.b) && p.contra.length),
  );
  const tripleWeak = (p: Pair) =>
    p.weak.some((w) => w.startsWith("SAME_BONBUN")) &&
    p.weak.some((w) => w.startsWith("WITHIN_")) &&
    p.weak.some((w) => w.startsWith("SAME_APPROVAL_DATE"));

  let cls: string;
  const allContra = pairs.every((p) => p.contra.length && !p.strong.length);
  if (confirmedComps.length === 1 && confirmedComps[0].length === ms.length) cls = "CONFIRMED";
  else if (confirmedComps.length) cls = "PARTIAL"; // 일부 멤버만 확정
  else if (allContra) cls = "DIFFERENT";
  else if (pairs.some((p) => p.contra.length && !p.strong.length) && !pairs.some((p) => p.weak.length && !p.contra.length)) cls = "DIFFERENT";
  else if (pairs.some((p) => p.strong.length && p.contra.length)) cls = "CONFLICT";
  else if (pairs.some((p) => p.contra.length)) cls = "MIXED"; // 어떤 짝은 가깝고 어떤 짝은 반대 증거 — 사람 확인
  else cls = "LIKELY";

  // 대표(primary) 고르기: K-apt 있는 멤버 > 주거동 세대 합 큰 멤버 > 매매 건수 많은 멤버 > 본번·부번 작은 멤버
  const primaryOf = (cids: string[]) =>
    ms
      .filter((m) => cids.includes(m.complex_id))
      .sort(
        (x, y) =>
          (y.kapt.length ? 1 : 0) - (x.kapt.length ? 1 : 0) ||
          (y.kapt_households ?? 0) - (x.kapt_households ?? 0) ||
          y.res_households_sum - x.res_households_sum ||
          y.tx.trade - x.tx.trade,
      )[0].complex_id;

  results.push({
    group_key: key,
    lawd_cd: lawd,
    bjdong_cd: bjdong === "∅" ? null : bjdong,
    base_name: base,
    sigungu: s(rows[0].sigungu),
    legal_dong_name: s(rows[0].legal_dong_name),
    class: cls,
    parcel_triple_all_pairs: pairs.length > 0 && pairs.every(tripleWeak),
    confirmed_components: confirmedComps.map((c) => ({ primary_complex_id: primaryOf(c), member_complex_ids: c })),
    members: ms.map(({ points, lot, ...rest }) => ({ ...rest, point: points[0] ?? null, point_count: points.length })),
    pairs,
  });
}

// ── 5. 요약 ──────────────────────────────────────────────────
const byClass: Record<string, number> = {};
for (const r of results) byClass[r.class] = (byClass[r.class] ?? 0) + 1;
const confirmedMembers = results.flatMap((r) => r.confirmed_components.flatMap((c: any) => c.member_complex_ids));
const nonPrimary = results.flatMap((r) =>
  r.confirmed_components.flatMap((c: any) => c.member_complex_ids.filter((x: string) => x !== c.primary_complex_id)),
);
const memberIndex = new Map(results.flatMap((r) => r.members.map((m: any) => [m.complex_id, m])));
const sumRows = (cids: string[]) => {
  const out: Record<string, number> = { transactions_trade: 0, transactions_rent: 0 };
  for (const c of cids) {
    const m: any = memberIndex.get(c);
    out.transactions_trade += m.tx.trade;
    out.transactions_rent += m.tx.rent;
    for (const [t, v] of Object.entries(m.row_counts as Record<string, number>)) out[t] = (out[t] ?? 0) + v;
  }
  return out;
};
const summary = {
  generated_at: new Date().toISOString(),
  mode: "DRY_RUN_READ_ONLY",
  master_rows: master.length,
  candidate_groups: candidates.length,
  candidate_members: ids.length,
  candidate_groups_null_bjdong: nullBjdong.length,
  lawd_base_groups_any_dong: lawdOnlyGroups.length,
  lawd_base_groups_cross_dong: lawdOnlyCrossDong.length,
  by_class: byClass,
  confirmed_components: results.reduce((a, r) => a + r.confirmed_components.length, 0),
  confirmed_member_complexes: confirmedMembers.length,
  confirmed_non_primary_complexes: nonPrimary.length,
  likely_with_parcel_triple: results.filter((r) => r.class === "LIKELY" && r.parcel_triple_all_pairs).length,
  apply_estimate: {
    complex_group_rows: results.reduce((a, r) => a + r.confirmed_components.length, 0),
    complex_group_member_rows: confirmedMembers.length,
    rows_touched_by_member_redirect_readonly: sumRows(nonPrimary),
  },
  thresholds: { NEAR_M, FAR_M, APPROVAL_FAR_DAYS },
};
console.log(summary);

mkdirSync("data/complex-groups", { recursive: true });
writeFileSync(`data/complex-groups/dry-run-${DATE}.json`, JSON.stringify({ summary, groups: results }, null, 1));

// ── 6. markdown ─────────────────────────────────────────────
const fmtMember = (m: any) =>
  `\`${m.complex_id}\` ${m.apt_name} (지번 ${m.jibun ?? "-"}; K-apt ${m.kapt.join(",") || "-"}${m.official_households ? `; 공식총세대 ${m.official_households}(${m.official_hh_src})` : ""}; 주거동 ${m.buildings_res}개 ${m.res_households_sum}세대; 사용승인 ${m.approval_date ?? "-"}; 매매 ${m.tx.trade}/전월세 ${m.tx.rent})`;
const fmtGroup = (r: any) => {
  const lines = [`- **${r.base_name}** — ${r.sigungu ?? ""} ${r.legal_dong_name ?? ""} (lawd ${r.lawd_cd}, bjdong ${r.bjdong_cd}) · ${r.members.length}건`];
  for (const m of r.members) lines.push(`  - ${fmtMember(m)}`);
  for (const p of r.pairs) {
    const ev = [...p.strong.map((x: string) => `**${x}**`), ...p.weak, ...p.contra.map((x: string) => `✗${x}`)].join(" · ");
    if (r.pairs.length <= 6) lines.push(`  - 짝 ${p.a.slice(-6)}↔${p.b.slice(-6)}: ${ev || "(증거 없음)"}`);
  }
  if (r.pairs.length > 6) lines.push(`  - (짝 ${r.pairs.length}개 — JSON 참조)`);
  if (r.confirmed_components.length)
    lines.push(`  - 확정 묶음: ${r.confirmed_components.map((c: any) => `[대표 ${c.primary_complex_id} + ${c.member_complex_ids.length - 1}]`).join(" ")}`);
  return lines.join("\n");
};
const md: string[] = [];
md.push(`# 단지 묶음 DRY-RUN (${DATE})`, "", "읽기 전용. DB 쓰기 없음. 원본: `dry-run-" + DATE + ".json`", "");
md.push("## 집계", "", "```json", JSON.stringify(summary, null, 2), "```", "");
md.push(
  "분류 기준:",
  "- 강한 증거: 같은 K-apt 코드 / 같은 PNU / 같은 건축물대장 PK / K-apt 세대수 = 멤버들 주거동 세대 합(유일한 부분집합)",
  "- 약한 증거: 같은 본번(24, 24-1) · 가까운 본번(±2) · 150m 이내(건물 외곽 중심점 기준, 없으면 3D/지도 앵커) · 같은 사용승인일 · 사용승인 2년 이내",
  "- 반대 증거: 400m 초과 · 사용승인 2년 초과 차이(없으면 실거래 건축년도 3년 이상 차이) · 서로 다른 K-apt 코드",
  "- 공식총세대(K-apt 기본정보·총괄표제부) = 멤버 주거동 세대 합은 30세대 이상, 유일한 부분집합, 공간 증거(같은 본번 또는 150m)가 같이 있을 때만 강한 증거",
  "- 거리: GIS 동 외곽선 꼭짓점끼리 최소 거리(footprint). 외곽선 없으면 3D 앵커/지도 앵커 점",
  "- CONFIRMED = 모든 멤버가 강한 증거로 이어지고 반대 증거 없음 · PARTIAL = 일부 멤버만 확정 · LIKELY = 약한 증거만(자동 병합 금지) · DIFFERENT = 반대 증거만 · MIXED = 가까운 짝과 반대 증거 짝이 섞임 · CONFLICT = 강한 증거와 반대 증거가 같이 있음",
  "",
);
for (const c of ["CONFIRMED", "PARTIAL", "LIKELY", "MIXED", "CONFLICT", "DIFFERENT"]) {
  const list = results.filter((r) => r.class === c);
  if (!list.length) continue;
  md.push(`## ${c} (${list.length}) — 예시 ${Math.min(20, list.length)}`, "");
  for (const r of list.slice(0, 20)) md.push(fmtGroup(r));
  md.push("");
}
const yp = results.filter((r) => r.base_name === "용산파크타워");
md.push("## 용산파크타워", "");
for (const r of yp) md.push(fmtGroup(r));
writeFileSync(`data/complex-groups/dry-run-${DATE}.md`, md.join("\n"));
console.log("wrote", `data/complex-groups/dry-run-${DATE}.json/.md`);
