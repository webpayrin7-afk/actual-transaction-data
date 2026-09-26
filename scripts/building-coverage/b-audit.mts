/**
 * B) 서울 단지별 3D 동 모양 연결 감사 + 엄격한(빈 것만) 채우기 후보 — 읽기만 (DB 쓰기 없음).
 *   npx tsx scripts/building-coverage/pull.mts      # 먼저 (캐시)
 *   npx tsx scripts/building-coverage/b-audit.mts   # → data/building-coverage/b-*.json, b-top50.csv
 *
 * 연결은 read.ts와 같다: 같은 시군구 + 대장번호 뒤쪽(앞 5자리 제외) 같음 + 단지 좌표 1km 안 + 외곽선 있음.
 * 후보 규칙 (이름 유사·거리만으로 붙이지 않음):
 *   - 아무 단지에도 연결 안 된 주거 GIS 행(공동주택/아파트), 다른 서울 단지 동 번호를 가진 행이 아님, 단지 좌표 500m 안
 *   - R1_PARCEL: GIS 행 PNU = 단지 필지 PNU (체크포인트 pnu · 마스터 법정동+지번 · 이미 연결된 동의 PNU) 와 정확히 같음
 *   - R2_MAINNO+NAME: 같은 법정동·같은 본번(부번만 다름) + 건물명 정규화 후 완전히 같음 (단지명·대장 건물명·이미 연결된 동의 GIS 이름)
 *   - 후보가 단지 하나에만 걸릴 때만
 *   - 동 표기 정규화가 빠진 동 하나와만 1:1이면 LINK_TO_CB, 동 표기가 없거나 대장 행이 없으면 EXTRA_SHAPE(대장 행 없는 단지 건물)
 *   - 캐시된 단지 경계(complex_site_boundary)가 있으면 도형 안쪽 점이 경계 안이어야 함
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";
import { haversine, innerPoint, inPoly, type Pt } from "./geo.mjs";

const OUT = "data/building-coverage";
const load = (n: string) => JSON.parse(readFileSync(`${OUT}/cache/${n}.json`, "utf8")) as any[];
const master = load("master");
const cbAll = load("cb");
const gis = load("gis");
const sites = load("site_boundary");
const LINK_MAX_M = 1000;
const CAND_MAX_M = 500;

const PUNCT = /[\s·.,\-_'"()[\]]/g;
const normName = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/아파트|apt/g, "")
    .replace(PUNCT, "");
const normDong = (s: unknown) => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const m = t.match(/^제?\s*(\d+)\s*동?$/);
  if (m) return String(Number(m[1]));
  return normName(t) || null;
};
const isRes = (g: any) => /공동주택|아파트/.test(String(g.use_name ?? "")) || /아파트/.test(String(g.name ?? ""));
const pnuOf = (m: any) => {
  const j = String(m.jibun ?? "").match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
  return j && m.bjdong_cd ? `${m.lawd_cd}${m.bjdong_cd}1${j[1]!.padStart(4, "0")}${(j[2] ?? "0").padStart(4, "0")}` : null;
};
/** PNU 대지구분 자리 — 체크포인트는 일반 필지를 '0'으로 적은 것이 있어 '1'로 맞춘다 (산 '2'는 그대로) */
const fixPnu = (p: unknown) => { const s = String(p ?? ""); return s.length === 19 && s[10] === "0" ? `${s.slice(0, 10)}1${s.slice(11)}` : s; };
const mainKey = (pnu: string) => (pnu && pnu.length === 19 ? `${pnu.slice(0, 10)}|${pnu[10]}|${pnu.slice(11, 15)}` : null);
function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

const gisByLawdPk = new Map<string, any[]>();
for (const g of gis) if (g.bldrgst_pk) push(gisByLawdPk, `${g.lawd_cd}|${g.bldrgst_pk}`, g);
const cbByCx = new Map<string, any[]>();
for (const b of cbAll) push(cbByCx, b.complex_id, b);
const mById = new Map(master.map((m) => [m.complex_id, m]));
const siteById = new Map(sites.map((s) => [s.complex_id, s]));
const cbKeys = new Set<string>();
for (const b of cbAll) {
  const m = mById.get(b.complex_id);
  if (m && b.pk && String(b.pk).length > 5) cbKeys.add(`${m.lawd_cd}|${String(b.pk).slice(5)}`);
}

const gisByKeyAll = new Map(gis.map((g) => [g.bld_key, g]));
// 1) read.ts와 같은 연결
type Cx = { m: any; cbs: any[]; linked: Map<string, any>; mains?: Set<string> };
const cxs: Cx[] = [];
const claimed = new Map<string, string>();
for (const m of master) {
  if (m.lat == null) continue;
  const cbs = cbByCx.get(m.complex_id) ?? [];
  const linked = new Map<string, any>();
  for (const b of cbs) {
    const pk = String(b.pk ?? "");
    if (pk.length <= 5) continue;
    const rows = (gisByLawdPk.get(`${m.lawd_cd}|${pk.slice(5)}`) ?? []).filter(
      (g) => haversine(m.lat, m.lng, g.lat, g.lng) <= LINK_MAX_M,
    );
    const g = rows[rows.length - 1];
    if (g && g.rings && g.rings !== "null") {
      linked.set(b.building_id, g);
      claimed.set(g.bld_key, m.complex_id);
    }
  }
  cxs.push({ m, cbs, linked });
}

// 2) 진단 — 서울 캐시에 같은 시군구·번호 행이 없으면 DB에서 번호로 전국 조회 (색인 idx_gis_buildings_bldrgst, 400개씩)
const needPk = new Set<string>();
for (const c of cxs)
  for (const b of c.cbs) {
    const pk = String(b.pk ?? "");
    if (pk.length > 5 && !c.linked.has(b.building_id) && !gisByLawdPk.has(`${c.m.lawd_cd}|${pk.slice(5)}`)) needPk.add(pk.slice(5));
  }
const elsewhere = new Map<string, any[]>();
const EW = `${OUT}/cache/pk-elsewhere.json`;
if (existsSync(EW)) for (const [k, v] of JSON.parse(readFileSync(EW, "utf8"))) elsewhere.set(k, v);
else {
  const db = getDb()!;
  const arr = [...needPk];
  for (let i = 0; i < arr.length; i += 400) {
    const part = arr.slice(i, i + 400);
    const rows = (
      await db.execute({
        sql: `SELECT bldrgst_pk, lawd_cd, lat, lng FROM gis_buildings WHERE bldrgst_pk IN (${part.map(() => "?").join(",")})`,
        args: part,
      })
    ).rows;
    for (const r of rows) push(elsewhere, String(r.bldrgst_pk), { lawd: r.lawd_cd, lat: r.lat, lng: r.lng });
  }
  writeFileSync(EW, JSON.stringify([...elsewhere]));
}
console.log("pk lookups", needPk.size, "found elsewhere", elsewhere.size);

function diagnose(c: Cx, b: any): string {
  const pk = String(b.pk ?? "");
  if (pk.length <= 5) return "NO_PK";
  const same = gisByLawdPk.get(`${c.m.lawd_cd}|${pk.slice(5)}`) ?? [];
  if (same.length) {
    if (same.every((g) => haversine(c.m.lat, c.m.lng, g.lat, g.lng) > LINK_MAX_M)) return "SAME_LAWD_FAR_GT_1KM";
    return "EMPTY_RINGS";
  }
  const ew = elsewhere.get(pk.slice(5)) ?? [];
  if (ew.some((r) => haversine(c.m.lat, c.m.lng, Number(r.lat), Number(r.lng)) <= LINK_MAX_M)) return "PK_OTHER_LAWD_NEAR";
  if (ew.length) return "NO_GIS_ROW_HERE(pk only far, other sigungu)";
  return "NO_GIS_ROW";
}

// 3) 엄격한 후보
// 연결된 모양(모든 서울 단지) 격자 색인 — 후보가 이미 그려지는 동과 겹치면(중복) 뺀다
type Shape = { rings: Pt[][]; ip: Pt | null; cx: string };
const grid = new Map<string, Shape[]>();
const cell = (lng: number, lat: number) => `${Math.floor(lng * 400)}|${Math.floor(lat * 500)}`;
for (const [key, cxId] of claimed) {
  const g = gisByKeyAll.get(key);
  let rings: Pt[][];
  try { rings = JSON.parse(g.rings); } catch { continue; }
  const sh: Shape = { rings, ip: innerPoint(rings), cx: cxId };
  const [lng, lat] = sh.ip ?? [g.lng, g.lat];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) push(grid, `${Math.floor(lng * 400) + dx}|${Math.floor(lat * 500) + dy}`, sh);
}
function overlapsLinked(rings: Pt[][]): Shape | null {
  const ip = innerPoint(rings);
  if (!ip) return null;
  for (const sh of grid.get(cell(ip[0], ip[1])) ?? [])
    if (inPoly(ip, sh.rings) || (sh.ip && inPoly(sh.ip, rings))) return sh;
  return null;
}
const year = (v: unknown) => { const m = String(v ?? "").match(/^(\d{4})/); return m ? Number(m[1]) : null; };
const ERA_TOL = 3;

const gisFree = gis.filter(
  (g) => !claimed.has(g.bld_key) && isRes(g) && g.rings && !(g.bldrgst_pk && cbKeys.has(`${g.lawd_cd}|${g.bldrgst_pk}`)),
);
const freeByMain = new Map<string, any[]>();
for (const g of gisFree) {
  const k = mainKey(fixPnu(g.pnu));
  if (k) push(freeByMain, k, g);
}
const candBy = new Map<string, Array<{ cx: string; rule: string }>>();
for (const c of cxs) {
  const pnus = new Set<string>();
  const p0 = fixPnu(c.m.cp_pnu);
  if (p0.length === 19) pnus.add(p0);
  const p1 = pnuOf(c.m);
  if (p1) pnus.add(p1);
  for (const g of c.linked.values()) if (g.pnu && String(g.pnu).length === 19) pnus.add(fixPnu(g.pnu));
  const names = new Set<string>(
    [
      normName(c.m.apt_name),
      normName(c.m.apt_name_norm),
      ...c.cbs.map((b) => normName(b.building_name)),
      ...[...c.linked.values()].map((g) => normName(g.name)),
    ].filter((s) => s.length >= 2),
  );
  const mains = new Set([...pnus].map(mainKey).filter(Boolean) as string[]);
  c.mains = mains;
  // 대장에 모양 있는 동이 하나도 없으면(철거·재건축으로 대장이 닫힌 단지 등) 옛 GIS 건물을 붙일 위험 — 후보를 만들지 않는다
  if (!c.linked.size) continue;
  const eras = [...c.linked.values()].map((g) => year(g.appr)).filter((y): y is number => y != null);
  for (const k of mains)
    for (const g of freeByMain.get(k) ?? []) {
      if (haversine(c.m.lat, c.m.lng, g.lat, g.lng) > CAND_MAX_M) continue;
      // 같은 시기 준공만 (연결된 동 사용승인 연도 ±3년) — 철거 전 옛 건물 방지
      const gy = year(g.appr);
      if (gy == null || !eras.some((y) => Math.abs(y - gy) <= ERA_TOL)) continue;
      let gr: Pt[][];
      try { gr = JSON.parse(g.rings); } catch { continue; }
      if (overlapsLinked(gr)) continue;
      const exact = pnus.has(fixPnu(g.pnu));
      const nameHit = names.has(normName(g.name));
      const rule = exact && nameHit ? "R1_PARCEL+NAME" : exact ? "R1_PARCEL" : nameHit ? "R2_MAINNO+NAME" : null;
      if (!rule) continue;
      push(candBy, g.bld_key, { cx: c.m.complex_id, rule });
    }
}
const gisByKey = new Map(gis.map((g) => [g.bld_key, g]));
const candByCx = new Map<string, Array<{ g: any; rule: string }>>();
let ambiguous = 0;
for (const [k, list] of candBy) {
  const ids = new Set(list.map((x) => x.cx));
  if (ids.size !== 1) {
    ambiguous++;
    continue;
  }
  push(candByCx, list[0]!.cx, { g: gisByKey.get(k), rule: list[0]!.rule });
}

// 3b) SPBD 캐시(브이월드 도로명주소 건물, 단지 ±700m — fill-gis-from-vworld-spbd.mts가 받아 둔 것) 후보 — 모양이 빠진 단지만
//   R3_SPBD_NAME: 건물명 정규화 후 단지명·대장 건물명과 완전히 같음, 500m 안, 이미 gis_buildings에 없음
//   R3_SPBD_ROAD: 건물명이 비었고 도로명주소(시군구|도로명|건물번호)가 R3_SPBD_NAME 건물과 같음
//   다른 서울 단지 (1km 안)가 같은 이름이면 뺀다. 동 표기 1:1이면 LINK_TO_CB, 아니면 EXTRA_SHAPE.
const SPBD_DIR = "C:/data/fixes/gis-spbd/cache";
const gisSpbdKeys = new Set(gis.filter((g) => g.ct === "SPBD").map((g) => String(g.bld_key).replace(/^SPBD:/, "")));
const nameCx = new Map<string, any[]>(); // 정규화 단지명 → 단지들
for (const m of master) if (m.lat != null) for (const n of [normName(m.apt_name), normName(m.apt_name_norm)]) if (n.length >= 2) push(nameCx, n, m);
// 서울 SPBD 전체(캐시 합본, spbd-index.mts) — 격자(약 200m)로 찾아 단지 캐시 파일이 없어도 이웃 단지가 받아 둔 건물을 쓴다
const SPBD_INDEX = `${OUT}/cache/spbd-seoul.json`;
const spbdAll: any[] = existsSync(SPBD_INDEX) ? JSON.parse(readFileSync(SPBD_INDEX, "utf8")) : [];
const spbdGrid = new Map<string, any[]>();
for (const f of spbdAll) {
  if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
  push(spbdGrid, `${Math.floor(f.lng * 400)}|${Math.floor(f.lat * 500)}`, f);
}
console.log("spbd index", spbdAll.length);
function spbdNear(lat: number, lng: number, r: number): any[] {
  const out: any[] = [];
  const cx = Math.floor(lng * 400), cy = Math.floor(lat * 500);
  const k = Math.ceil(r / 200) + 1;
  for (let dx = -k; dx <= k; dx++) for (let dy = -k; dy <= k; dy++) for (const f of spbdGrid.get(`${cx + dx}|${cy + dy}`) ?? []) if (haversine(lat, lng, f.lat, f.lng) <= r) out.push(f);
  return out;
}
function spbdCandidates(c: Cx): { list: Array<{ f: any; rule: string }>; cached: boolean } {
  const arr = spbdNear(c.m.lat, c.m.lng, CAND_MAX_M);
  const cached = existsSync(`${SPBD_DIR}/${c.m.complex_id}.json`) || arr.length > 0;
  const names = new Set<string>([normName(c.m.apt_name), normName(c.m.apt_name_norm), ...c.cbs.map((b) => normName(b.building_name))].filter((s) => s.length >= 2));
  const out: Array<{ f: any; rule: string }> = [];
  const roads = new Set<string>();
  for (const f0 of arr) {
    if (gisSpbdKeys.has(f0.bd_mgt_sn)) continue;
    const f = { ...f0 };
    // "은마아파트(18동)" · "은마아파트1동" — 동 표기가 이름에 붙은 경우 떼어 동 표기로
    if (!f.buld_nm_dc) {
      const dm = String(f.buld_nm ?? "").match(/\(?\s*(제?\d+\s*동)\s*\)?\s*$/);
      if (dm) f.buld_nm_dc = dm[1];
    }
    const n = normName(String(f.buld_nm ?? "").replace(/\(?\s*제?\d+\s*동\s*\)?\s*$/, ""));
    if (!n || !names.has(n)) continue;
    const others = (nameCx.get(n) ?? []).filter((o) => o.complex_id !== c.m.complex_id && haversine(o.lat, o.lng, f.lat, f.lng) <= LINK_MAX_M);
    if (others.length) continue;
    if (overlapsLinked(f.rings)) continue; // 이미 그려지는 동(AL_D010 등)과 같은 건물
    const snMain = mainKey(fixPnu(String(f.bd_mgt_sn).slice(0, 19)));
    out.push({ f, rule: snMain && c.mains?.has(snMain) ? "R3_SPBD_NAME+PARCEL" : "R3_SPBD_NAME" });
    roads.add(f.road);
  }
  for (const f of arr) {
    if (gisSpbdKeys.has(f.bd_mgt_sn) || normName(f.buld_nm) || !roads.has(f.road)) continue;
    if (overlapsLinked(f.rings)) continue;
    out.push({ f: { ...f }, rule: "R3_SPBD_ROAD" });
  }
  // 아주 작은 부속(경비실 등, 30㎡ 미만)은 뺀다
  return {
    list: out.filter((x) => {
      const r = x.f.rings?.[0];
      if (!r) return false;
      const lat = (r[0][1] * Math.PI) / 180;
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
      return Math.abs(a / 2) * 111320 * 111320 * Math.cos(lat) >= 30;
    }),
    cached,
  };
}

// 같은 단지가 마스터 둘 이상으로 나뉜 것 (괄호·끝 번호/단지/차/a·b 뗀 이름이 같고 400m 안) — 이런 단지는 대장 없는 모양(EXTRA)을 붙이지 않는다
const base = (s: string) => normName(String(s).replace(/\(.*$/, "")).replace(/(\d+(단지|차|동)?|[a-z]동?)$/, "");
const byBase = new Map<string, any[]>();
for (const m of master) if (m.lat != null) push(byBase, `${m.lawd_cd}|${base(m.apt_name)}`, m);
const splitOf = new Map<string, string[]>();
for (const list of byBase.values())
  if (list.length > 1)
    for (const a of list) {
      const sib = list.filter((b) => b !== a && haversine(a.lat, a.lng, b.lat, b.lng) < 400).map((b) => b.apt_name);
      if (sib.length) splitOf.set(a.complex_id, sib);
    }
// 이름 주인 — 정규화 이름을 쓰는 단지들 (마스터 이름 · 대장 건물명 · 연결된 GIS 이름). 1km 안 다른 단지도 쓰는 이름이면 이름 규칙을 쓰지 않는다
const owners = new Map<string, Map<string, [number, number]>>();
const own = (n: string, cx: any) => {
  if (n.length < 2) return;
  const o = owners.get(n) ?? owners.set(n, new Map()).get(n)!;
  o.set(cx.complex_id, [cx.lat, cx.lng]);
};
for (const c of cxs) {
  own(normName(c.m.apt_name), c.m);
  own(normName(c.m.apt_name_norm), c.m);
  for (const b of c.cbs) own(normName(b.building_name), c.m);
  for (const g of c.linked.values()) own(normName(g.name), c.m);
}
const nameShared = (n: string, c: Cx) =>
  [...(owners.get(n) ?? new Map<string, [number, number]>()).entries()].some(
    ([id, [la, ln]]) => id !== c.m.complex_id && haversine(la, ln, c.m.lat, c.m.lng) <= LINK_MAX_M,
  );
const DONG_SPECIFIC = /\d+\s*동|\(\s*\d|~/; // "청구103동" · "염광(5,8,10,11동)" · "(101~111동)" — 동 일부만 가진 마스터
const MIN_EXTRA_M2 = 100;
const areaOf = (rings: Pt[][]) => {
  const r = rings?.[0];
  if (!r) return 0;
  const lat = (r[0]![1] * Math.PI) / 180;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
  return Math.abs(a / 2) * 111320 * 111320 * Math.cos(lat);
};

// 4) 단지별 집계
const rows: any[] = [];
const diagTotals: Record<string, number> = {};
const tally = { cx: 0, cxLink: 0, cxExtra: 0, linkToCb: 0, extraShape: 0, byRule: {} as Record<string, number>, dropped: {} as Record<string, number> };
const drop = (why: string, n = 1) => {
  tally.dropped[why] = (tally.dropped[why] ?? 0) + n;
};
let spbdEvaluated = 0;
let spbdNoCache = 0;
const samples: any[] = [];
type Cand = { src: "gis" | "spbd"; rule: string; rings: Pt[][]; name: string; dong: string | null; fl: number | null; ref: any; distM: number };
for (const c of cxs) {
  const m = c.m;
  const resCbs = c.cbs.filter((b) => Number(b.r) === 1);
  const withShape = c.linked.size;
  const pbc = m.p_bc == null ? null : Number(m.p_bc);
  const missCb = c.cbs.filter((b) => !c.linked.has(b.building_id));
  const diag: Record<string, number> = {};
  for (const b of missCb) {
    const d = diagnose(c, b);
    diag[d] = (diag[d] ?? 0) + 1;
    diagTotals[d] = (diagTotals[d] ?? 0) + 1;
  }
  const regShort = pbc != null && pbc > c.cbs.length ? pbc - c.cbs.length : 0;
  if (regShort) {
    diag.REGISTER_ROWS_FEWER_THAN_KAPT = regShort;
    diagTotals.REGISTER_ROWS_FEWER_THAN_KAPT = (diagTotals.REGISTER_ROWS_FEWER_THAN_KAPT ?? 0) + regShort;
  }
  const hhCb = resCbs.reduce((s2, b) => s2 + (Number(b.hh) || 0), 0);
  const hhFlag = m.p_hh && hhCb < Number(m.p_hh) * 0.7 ? `hh cb ${hhCb} < kapt ${m.p_hh}` : "";

  // 후보 모으기: GIS(R1/R2) + SPBD(R3)
  const cands: Cand[] = [];
  for (const x of candByCx.get(m.complex_id) ?? [])
    cands.push({ src: "gis", rule: x.rule, rings: JSON.parse(x.g.rings), name: x.g.name ?? "", dong: x.g.dong_name ?? null, fl: x.g.fl ?? null, ref: x.g, distM: Math.round(haversine(m.lat, m.lng, x.g.lat, x.g.lng)) });
  let spbdCached: boolean | null = null;
  if (missCb.length || regShort || hhFlag || c.cbs.length === 0) {
    const { list, cached } = spbdCandidates(c);
    spbdCached = cached;
    if (cached) spbdEvaluated++;
    else spbdNoCache++;
    for (const x of list)
      cands.push({ src: "spbd", rule: x.rule, rings: x.f.rings, name: x.f.buld_nm ?? "", dong: x.f.buld_nm_dc || null, fl: x.f.gro_flo_co ?? null, ref: x.f, distM: Math.round(haversine(m.lat, m.lng, x.f.lat, x.f.lng)) });
  }
  // 같은 건물이 두 원천(GIS·SPBD)에 → 먼저 온 GIS 쪽 남김
  const uniq: Cand[] = [];
  for (const x of cands) {
    const ip = innerPoint(x.rings);
    if (ip && uniq.some((u) => inPoly(ip, u.rings))) {
      drop("dup_between_sources");
      continue;
    }
    uniq.push(x);
  }
  // 이름 규칙은 1km 안 다른 단지와 이름을 같이 쓰면 버린다
  const named = uniq.filter((x) => {
    if (!/NAME/.test(x.rule)) return true;
    const n = normName(String(x.name).replace(/\(?\s*제?\d+\s*동\s*\)?\s*$/, ""));
    if (nameShared(n, c)) {
      drop("name_shared_with_nearby_complex");
      return false;
    }
    return true;
  });
  const missByDong = new Map<string, any[]>();
  for (const b of missCb) {
    const d = normDong(b.dong_label);
    if (d) push(missByDong, d, b);
  }
  const candByDong = new Map<string, Cand[]>();
  for (const x of named) {
    const d = normDong(x.dong);
    if (d) push(candByDong, d, x);
  }
  const linkedDongs = new Set(c.cbs.filter((b) => c.linked.has(b.building_id)).map((b) => normDong(b.dong_label)).filter(Boolean));
  const site = siteById.get(m.complex_id);
  const sitePolys: Pt[][][] | null = site ? JSON.parse(site.polys) : null;
  const links: Array<{ x: Cand; b: any }> = [];
  let extras: Cand[] = [];
  for (const x of named) {
    const d = normDong(x.dong);
    if (sitePolys) {
      const ip = innerPoint(x.rings);
      if (!ip || !sitePolys.some((pl) => inPoly(ip, pl))) {
        drop("outside_cached_site_boundary");
        continue;
      }
    }
    if (d && linkedDongs.has(d)) {
      drop("same_dong_as_already_linked");
      continue;
    }
    if (d && (missByDong.get(d)?.length ?? 0) === 1 && (candByDong.get(d)?.length ?? 0) === 1) {
      // 층수 확인 (fill-gis-from-vworld-spbd.mts와 같음): 둘 다 있으면 2층 넘게 다르면 버림. SPBD 지상층수 1은 고층 동에서 자리값이라 확인 안 함
      const b = missByDong.get(d)![0];
      const cf = Number(b.fl) || null;
      const sf = Number(x.fl) || null;
      if (cf && sf && !(x.src === "spbd" && sf === 1 && cf >= 3) && Math.abs(cf - sf) > 2) {
        drop("floor_count_differs_gt2");
        continue;
      }
      links.push({ x, b });
      continue;
    }
    if (d && (candByDong.get(d)?.length ?? 0) > 1) {
      drop("dong_label_ambiguous");
      continue;
    }
    extras.push(x);
  }
  // 대장 없는 모양(EXTRA) — 더 엄격하게: 동 일부만 가진 마스터·나뉜 마스터 아님, SPBD는 필지 근거 필요, 100㎡ 이상,
  // K-apt 동 수가 있으면 (모양 있는 동 + 연결 + EXTRA) ≤ max(K-apt, 대장 행 수) (넘으면 그 단지 EXTRA 전부 버림 — 개수는 검산에만 씀)
  if (extras.length) {
    if (DONG_SPECIFIC.test(m.apt_name)) {
      drop("extra_dong_specific_master", extras.length);
      extras = [];
    } else if (splitOf.has(m.complex_id)) {
      drop("extra_split_master", extras.length);
      extras = [];
    }
  }
  extras = extras.filter((x) => {
    if (x.rule === "R3_SPBD_NAME") {
      // 필지 근거가 없으면 캐시된 단지 경계(지적도 필지) 안일 때만 — 위에서 경계 밖은 이미 버렸다
      if (!sitePolys) {
        drop("extra_spbd_name_without_parcel_or_site");
        return false;
      }
      x.rule = "R3_SPBD_NAME+SITE";
    }
    if (areaOf(x.rings) < MIN_EXTRA_M2) {
      drop("extra_small_lt_100m2");
      return false;
    }
    return true;
  });
  // 대장 행 하나(동 표기 없음)만 모양이 없고 EXTRA 후보도 하나면 그 행에 붙인다 (층수 2층 이내)
  {
    const noLabel = missCb.filter((b) => !normDong(b.dong_label) && !links.some((l) => l.b === b));
    const cf = Number(noLabel[0]?.fl) || null;
    const sf = Number(extras[0]?.fl) || null;
    // 후보에 동 표기(부속 이름 "전기실" 등 포함)가 없고, 층수가 둘 다 있고 2층 이내일 때만
    if (noLabel.length === 1 && extras.length === 1 && !extras[0]!.dong && cf && sf && Math.abs(cf - sf) <= 2) {
      extras[0]!.rule += "+SINGLE_1TO1";
      links.push({ x: extras[0]!, b: noLabel[0] });
      extras = [];
    }
  }
  if (extras.length && pbc != null && withShape + links.length + extras.length > Math.max(pbc, c.cbs.length)) {
    drop("extra_exceeds_kapt_building_count", extras.length);
    extras = [];
  }

  if (links.length + extras.length) {
    tally.cx++;
    if (links.length) tally.cxLink++;
    if (extras.length) tally.cxExtra++;
  }
  tally.linkToCb += links.length;
  tally.extraShape += extras.length;
  const out = [...links.map((l) => ({ kind: "LINK_TO_CB", x: l.x, b: l.b })), ...extras.map((x) => ({ kind: "EXTRA_SHAPE", x, b: null as any }))];
  for (const f of out) {
    tally.byRule[`${f.kind}|${f.x.rule}`] = (tally.byRule[`${f.kind}|${f.x.rule}`] ?? 0) + 1;
    const r = f.x.ref;
    samples.push({
      complex_id: m.complex_id,
      apt: m.apt_name,
      kind: f.kind,
      rule: f.x.rule,
      src: f.x.src,
      shape:
        f.x.src === "gis"
          ? { bld_key: r.bld_key, pnu: r.pnu, pk: r.bldrgst_pk, name: r.name, dong: r.dong_name, use: r.use_name, fl: r.fl, appr: r.appr, dist_m: f.x.distM }
          : { bld_key: `SPBD:${r.bd_mgt_sn}`, sn_parcel: String(r.bd_mgt_sn).slice(0, 19), name: r.buld_nm, dong: r.buld_nm_dc, fl: r.gro_flo_co, road: r.road, dist_m: f.x.distM },
      area_m2: Math.round(areaOf(f.x.rings)),
      cb: f.b ? { building_id: f.b.building_id, pk: f.b.pk, dong: f.b.dong_label, name: f.b.building_name, fl: f.b.fl } : null,
      complex: { pnu: m.cp_pnu, jibun: `${m.legal_dong_name} ${m.jibun}`, kapt_bc: pbc, kapt_hh: m.p_hh, cb: c.cbs.length, withShape, siteCached: !!site },
    });
  }
  const gl = links.filter((l) => l.x.src === "gis").length;
  const sl = links.length - gl;
  const gx = extras.filter((x) => x.src === "gis").length;
  const sx = extras.length - gx;
  const exp = Math.max(c.cbs.length, pbc ?? 0, withShape + links.length + extras.length);
  rows.push({
    complex_id: m.complex_id,
    apt: m.apt_name,
    gu: m.lawd_cd,
    dong: m.legal_dong_name,
    jibun: m.jibun,
    appr: m.p_appr,
    kapt_hh: m.p_hh,
    kapt_bc: pbc,
    cb: c.cbs.length,
    cb_res: resCbs.length,
    withShape,
    // 기대 동 수: 대장 행 수 · K-apt 동 수 · (모양 있는 동 + 엄격 후보) 중 큰 값
    expected: exp,
    expectedBasis: exp === c.cbs.length ? "register" : pbc != null && exp === pbc ? "kapt_bc" : "candidates",
    missing: exp - withShape,
    diag,
    hhFlag,
    fillLinkToCb: gl,
    fillExtra: gx,
    spbdLinkToCb: sl,
    spbdExtra: sx,
    spbdCached,
    siteCached: !!site,
    splitWith: splitOf.get(m.complex_id),
  });
}
const fillTotals = tally;
const spbdTotals = { cxEvaluated: spbdEvaluated, cxNoCache: spbdNoCache };
const spbdSamples = samples.filter((x) => x.src === "spbd");


rows.sort((a, b) => b.missing - a.missing || b.expected - a.expected);
const summary = {
  complexes: rows.length,
  withAnyCb: rows.filter((r) => r.cb > 0).length,
  cbTotal: rows.reduce((s, r) => s + r.cb, 0),
  withShapeTotal: rows.reduce((s, r) => s + r.withShape, 0),
  expectedTotal: rows.reduce((s, r) => s + r.expected, 0),
  complexesFull: rows.filter((r) => r.expected > 0 && r.missing === 0).length,
  complexesZero: rows.filter((r) => r.expected > 0 && r.withShape === 0).length,
  complexesPartial: rows.filter((r) => r.withShape > 0 && r.missing > 0).length,
  complexesHhFlag: rows.filter((r) => r.hhFlag).length,
  masterSplitComplexes: splitOf.size,
  diagTotals,
  fillTotals,
  ambiguousCandidates: ambiguous,
  spbdTotals,
  missingTotal: rows.reduce((s2, r) => s2 + r.missing, 0),
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/b-summary.json`, JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/b-complexes.json`, JSON.stringify(rows));
writeFileSync(`${OUT}/b-fill-candidates.json`, JSON.stringify(samples.filter((x) => x.src === "gis"), null, 1));
writeFileSync(`${OUT}/b-fill-candidates-spbd.json`, JSON.stringify(spbdSamples, null, 1));
const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = [
  "rank,complex_id,apt,lawd,dong,jibun,approval,kapt_hh,kapt_bc,cb,cb_res,with_shape,expected,expected_basis,missing,diag,hh_flag,split_with,fill_gis_link_to_cb,fill_gis_extra,fill_spbd_link_to_cb,fill_spbd_extra,spbd_cached",
];
rows.slice(0, 50).forEach((r, i) =>
  csv.push(
    [i + 1, r.complex_id, r.apt, r.gu, r.dong, r.jibun, r.appr, r.kapt_hh, r.kapt_bc, r.cb, r.cb_res, r.withShape, r.expected, r.expectedBasis, r.missing,
      Object.entries(r.diag).map(([k, v]) => `${k}:${v}`).join(" "), r.hhFlag, (r.splitWith ?? []).join("/"), r.fillLinkToCb, r.fillExtra, r.spbdLinkToCb, r.spbdExtra, r.spbdCached]
      .map(q)
      .join(","),
  ),
);
writeFileSync(`${OUT}/b-top50.csv`, "﻿" + csv.join("\n"));
console.table(
  rows.slice(0, 50).map((r) => ({
    apt: r.apt,
    dong: r.dong,
    bc: r.kapt_bc,
    cb: r.cb,
    shp: r.withShape,
    miss: r.missing,
    diag: Object.entries(r.diag).map(([k, v]) => `${k.slice(0, 12)}:${v}`).join(" "),
    L: r.fillLinkToCb,
    X: r.fillExtra,
    SL: r.spbdLinkToCb,
    SX: r.spbdExtra,
  })),
);
