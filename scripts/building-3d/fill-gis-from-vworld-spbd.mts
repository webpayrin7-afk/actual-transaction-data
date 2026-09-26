/**
 * 3D 동 모양이 없는 단지 동에 도로명주소 건물 도형(브이월드 데이터 API LT_C_SPBD, 행안부 도로명주소 전자지도 건물)을 채운다.
 *
 * 원인: gis_buildings는 국토부 GIS건물통합정보(AL_D010)에서 적재했는데, 이 원천에는 최근 준공 단지가 없거나
 * 철거 전 건물이 남아 있다 (헬리오시티 0/93, 래미안원베일리 0/23 — 원베일리 자리에는 1978 반포경남이 그대로).
 * 도로명주소 건물 도형은 준공 후 도로명주소 부여 때 갱신되어 현재 동 모양·동 명칭(buld_nm_dc "101동")·지상층수가 있다.
 *
 * 연결 규칙 (추정·유사 이름 없음 — scripts/fixes/link-gis-null-bldrgst.mts와 같은 정규화):
 *   SPBD 건물 f ↔ 단지 동 b 는
 *     - (이름) f의 건물명(buld_nm, 동 명칭 앞에 이름이 있으면 그것도)이 단지명(apt_name·apt_name_norm) 또는 대장 건물명(building_name)과
 *       정규화 후 완전히 같거나 (소문자, 공백·괄호·구두점 제거, "아파트"/"apt" 제거),
 *       (지번) f에 건물명이 비어 있으면(원베일리처럼) f 대표점의 지번(브이월드 역지오코딩 getAddress type=parcel)이
 *       단지 대표 지번(complex_building_checkpoint.parcel_key 또는 master 법정동+지번)과 같거나,
 *       (도로명주소) f에 건물명이 비어 있고 도로명주소(시군구·도로명·건물번호)가 이 단지에 이름/지번으로 붙은 SPBD 건물과 같고
 *       그 도로명주소 안에서 같은 동 표기가 f 하나뿐일 때 — 다른 이름이 붙은 건물은 지번·도로명주소로 붙이지 않는다,
 *     - 동 표기가 같고 ("101동"/"제101동"/"101" → 101; 숫자가 아니면 정규화한 표기 전체가 같아야 함 — "A동" = "A동"),
 *     - f 대표점이 단지 좌표(지도 기준점 우선)에서 1km 안 (read.ts A_LINK_MAX_M),
 *     - 층수 둘 다 있으면 2층 넘게 다르지 않고,
 *     - f 하나에 b 하나, b 하나에 f 하나일 때만.
 *   이미 모양이 붙은 동(같은 시군구·같은 번호의 GIS 행이 단지 1km 안)은 건드리지 않는다. 같은 번호 GIS 행이 1km 안에 있으면
 *   (모양이 비어 있어도) 건너뛴다 — 읽기 쪽 번호 연결이 두 행 중 하나를 고르게 되므로.
 *
 * 쓰기: gis_buildings에 새 행만 INSERT OR IGNORE (bld_key = "SPBD:" + 도로명 건물관리번호). 기존 행은 절대 안 바꾼다.
 *   bldrgst_pk = 연결된 동의 건축물대장 번호 뒤쪽(앞 5자리 제외), lawd_cd = 단지 시군구 → read.ts는 그대로 동에 붙인다.
 *   change_type = 'SPBD' (출처 표시; read.ts가 이 행과 겹치는 옛 GIS 건물을 주변 건물에서 뺄 때 씀), height_m = null (원천에 높이 없음 —
 *   화면은 대장 높이 → 층수 순으로 그린다), floors_above = gro_flo_co, name/dong_name = buld_nm/buld_nm_dc, source_date = 받은 날.
 * 되돌리기: DELETE FROM gis_buildings WHERE change_type = 'SPBD' (또는 계획 파일의 bld_key).
 *
 *   npx tsx scripts/building-3d/fill-gis-from-vworld-spbd.mts                      # 대상 계산 + 도형 받기(캐시) + 계획 (DB 쓰기 없음)
 *   npx tsx scripts/building-3d/fill-gis-from-vworld-spbd.mts --complex cx_…       # 한 단지만 (여러 번 줄 수 있음)
 *   npx tsx scripts/building-3d/fill-gis-from-vworld-spbd.mts --limit 200          # 받기 대상 앞 N단지만 (동 많은 순)
 *   npx tsx scripts/building-3d/fill-gis-from-vworld-spbd.mts --no-fetch           # 캐시에 있는 것만으로 계획
 *   npx tsx scripts/building-3d/fill-gis-from-vworld-spbd.mts --apply              # 방금 만든 계획대로 넣는다
 *
 * 브이월드 호출: 단지마다 BOX(단지 좌표 ±700m) 한 번 + 쪽(1000건) 넘기기. 0.4초 간격. 응답은 C:/data/fixes/gis-spbd/cache/에 저장하고
 * 다시 받지 않는다. domain = 인증키 서비스 URL (VWORLD_DOMAIN, 기본 운영 주소 — 다르면 INCORRECT_KEY).
 * HTTP 429·한도 초과(OVER_REQUEST_LIMIT 등)·계속되는 INCORRECT_KEY는 멈춘다 — 다시 돌리면 캐시 다음부터 이어 받는다. 키는 로그에 찍지 않는다.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/gis-spbd";
const CACHE = join(OUT, "cache");
const LINK_MAX_M = 1000; // read.ts A_LINK_MAX_M
const BOX_M = 700;
const FLOOR_TOL = 2;
const GAP_MS = 400;
const PARCEL_CACHE = join(OUT, "parcel-by-bdmgtsn.json");
const KEY_RETRY = 3;
/** 데이터 API는 인증키에 등록한 서비스 URL을 domain으로 줘야 한다 (다르면 INCORRECT_KEY). */
const DOMAIN = process.env.VWORLD_DOMAIN?.trim() || "https://actual-transaction-data.vercel.app";

type Ring = Array<[number, number]>;
type Feature = {
  bd_mgt_sn: string;
  buld_nm: string;
  buld_nm_dc: string;
  gro_flo_co: number | null;
  sig: string;
  /** 시군구|도로명|건물번호 */
  road: string;
  lat: number;
  lng: number;
  rings: Ring[];
};
type Link = {
  bld_key: string;
  bldrgst_pk: string;
  lawd_cd: string;
  complex_id: string;
  apt_name: string;
  building_id: string;
  dong_label: string;
  spbd_label: string;
  floors_spbd: number | null;
  floors_ledger: number | null;
  dist_m: number;
  rule: "name" | "parcel" | "road_address";
  feature: Feature;
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

/** 동 표기 → 비교 키. "101동"/"제101동"/"101" → "#101", 그 밖의 "…동" → 정규화 전체, 나머지 null */
function dongKey(s: unknown): string | null {
  const t = String(s ?? "").replace(/\s/g, "");
  const m = t.match(/^제?(\d+)동?$/);
  if (m) return `#${Number(m[1])}`;
  if (/동$/.test(t) && t.length >= 2) return norm(t);
  return null;
}

/** SPBD 동 명칭에 이름이 붙은 경우("헬리오시티 101동") → [이름, 동키] */
function splitSpbdDong(s: string): [string, string | null] {
  const t = s.trim();
  const direct = dongKey(t);
  if (direct) return ["", direct];
  const m = t.match(/^(.*?)[\s(]*제?\s*(\d+)\s*동\)?$/);
  return m ? [norm(m[1]), `#${Number(m[2])}`] : ["", null];
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function argList(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

/** 넓이 가중 중심 (가장 큰 외곽선) */
function centroid(rings: Ring[]): { lat: number; lng: number } {
  let best: { a: number; x: number; y: number } | null = null;
  for (const ring of rings) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[i + 1]!;
      const f = x0 * y1 - x1 * y0;
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    if (a === 0) continue;
    const c = { a: Math.abs(a / 2), x: cx / (3 * a), y: cy / (3 * a) };
    if (!best || c.a > best.a) best = c;
  }
  if (!best) {
    const p = rings[0]![0]!;
    return { lat: p[1], lng: p[0] };
  }
  return { lat: Math.round(best.y * 1e7) / 1e7, lng: Math.round(best.x * 1e7) / 1e7 };
}

function toFeature(f: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }): Feature | null {
  const p = f.properties;
  const g = f.geometry;
  const polys = (g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : []) as number[][][][];
  const rings: Ring[] = polys
    .map((poly) => (poly[0] ?? []).map(([x, y]) => [Math.round(x! * 1e7) / 1e7, Math.round(y! * 1e7) / 1e7] as [number, number]))
    .filter((r) => r.length >= 4);
  if (!rings.length || !p.bd_mgt_sn) return null;
  const c = centroid(rings);
  const fl = num(p.gro_flo_co);
  return {
    bd_mgt_sn: String(p.bd_mgt_sn),
    buld_nm: String(p.buld_nm ?? ""),
    buld_nm_dc: String(p.buld_nm_dc ?? ""),
    gro_flo_co: fl && fl > 0 ? fl : null,
    sig: `${p.sido ?? ""} ${p.sigungu ?? ""}`.trim(),
    road: p.rd_nm && p.buld_no ? `${p.sido ?? ""} ${p.sigungu ?? ""}|${p.rd_nm}|${p.buld_no}` : "",
    lat: c.lat,
    lng: c.lng,
    rings,
  };
}

class StopFetch extends Error {}

/** "913" / "913-2" / 법정동코드 → "1171010700|913|0". 산 지번은 null */
function parcelKey(bjdong10: string, jibun: string): string | null {
  const m = String(jibun).trim().replace(/[^\d-]+$/, "").match(/^(\d+)(?:-(\d+))?$/);
  if (!/^\d{10}$/.test(bjdong10) || !m) return null;
  return `${bjdong10}|${Number(m[1])}|${Number(m[2] ?? 0)}`;
}

/** 점 → 지번 키 (브이월드 역지오코딩). 캐시. 없으면 "" */
async function pointParcel(key: string, lng: number, lat: number): Promise<string> {
  const url =
    `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0&crs=epsg:4326&type=parcel&format=json` +
    `&point=${lng},${lat}&key=${key}&domain=${encodeURIComponent(DOMAIN)}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.status === 429) throw new StopFetch("HTTP 429 (getAddress)");
    if (!res?.ok) {
      if (attempt < 3) continue;
      throw new StopFetch(`getAddress HTTP ${res?.status ?? "network"}`);
    }
    const j = (await res.json()) as {
      response: { status: string; error?: { code?: string }; result?: Array<{ structure?: { level4LC?: string; level5?: string } }> };
    };
    const r = j.response;
    if (r.status === "NOT_FOUND") return "";
    if (r.status !== "OK") {
      if (attempt < 3 && r.error?.code === "INCORRECT_KEY") continue;
      throw new StopFetch(`getAddress ${r.error?.code ?? r.status}`);
    }
    const st = r.result?.[0]?.structure;
    return (st?.level4LC && st.level5 && parcelKey(st.level4LC, st.level5)) || "";
  }
}

async function vworldPage(key: string, box: string, page: number): Promise<{ features: Feature[]; totalPages: number }> {
  const url =
    `https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&data=LT_C_SPBD&format=json` +
    `&geometry=true&attribute=true&crs=EPSG:4326&size=1000&page=${page}&geomFilter=BOX(${box})&key=${key}&domain=${encodeURIComponent(DOMAIN)}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt < 3) continue;
      throw new StopFetch(`network: ${(e as Error).message}`);
    }
    if (res.status === 429) throw new StopFetch("HTTP 429");
    if (!res.ok) {
      if (attempt < 3) continue;
      throw new StopFetch(`HTTP ${res.status}`);
    }
    const j = (await res.json()) as {
      response: {
        status: string;
        error?: { code?: string; text?: string };
        page?: { total?: string };
        result?: { featureCollection?: { features?: Array<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }> } };
      };
    };
    const r = j.response;
    if (r.status === "NOT_FOUND") {
      return { features: [], totalPages: 0 };
    }
    if (r.status === "OK") {
      const features = (r.result?.featureCollection?.features ?? []).map(toFeature).filter((x): x is Feature => !!x);
      return { features, totalPages: Number(r.page?.total ?? 1) };
    }
    const code = r.error?.code ?? r.status;
    if (code === "INCORRECT_KEY" && attempt < KEY_RETRY) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new StopFetch(`${code}: ${r.error?.text ?? ""}`);
  }
}

async function fetchComplex(key: string, cid: string, lat: number, lng: number): Promise<Feature[]> {
  const path = join(CACHE, `${cid}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Feature[];
  const dLat = BOX_M / 111_320;
  const dLng = BOX_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  const box = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(6)).join(",");
  const all: Feature[] = [];
  const first = await vworldPage(key, box, 1);
  all.push(...first.features);
  for (let p = 2; p <= first.totalPages; p++) all.push(...(await vworldPage(key, box, p)).features);
  writeFileSync(path, JSON.stringify(all));
  return all;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const noFetch = process.argv.includes("--no-fetch");
  const onlyComplexes = argList("complex");
  const limit = num(argList("limit")[0]);
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음 (.env.local)");
  mkdirSync(CACHE, { recursive: true });
  const tag = onlyComplexes.length ? `-${onlyComplexes.length === 1 ? onlyComplexes[0] : `${onlyComplexes.length}cx`}` : "";
  const planPath = join(OUT, `plan${tag}.json`);

  if (apply) {
    if (!existsSync(planPath)) throw new Error(`계획 파일 없음 (${planPath}) — 먼저 --apply 없이 돌리세요.`);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { links: Link[]; source_date: string };
    const now = new Date().toISOString();
    const cols = [
      "bld_key", "bldrgst_pk", "pnu", "bjdong_cd", "lawd_cd", "name", "dong_name", "use_code", "use_name", "structure",
      "height_m", "floors_above", "floors_below", "building_area", "total_floor_area", "approval_date",
      "lat", "lng", "rings", "source_date", "change_type",
    ];
    let inserted = 0;
    for (const part of chunks(plan.links, 100)) {
      const res = await db.batch(
        part.map((l) => {
          const f = l.feature;
          const vals: Record<string, unknown> = {
            bld_key: l.bld_key,
            bldrgst_pk: l.bldrgst_pk,
            lawd_cd: l.lawd_cd,
            name: f.buld_nm || null,
            dong_name: f.buld_nm_dc || null,
            floors_above: f.gro_flo_co,
            lat: f.lat,
            lng: f.lng,
            rings: JSON.stringify(f.rings),
            source_date: plan.source_date,
            change_type: "SPBD",
          };
          const hash = createHash("sha1").update(JSON.stringify(cols.map((c) => vals[c] ?? null))).digest("hex");
          return {
            sql: `INSERT OR IGNORE INTO gis_buildings (${cols.join(", ")}, payload_hash, loaded_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`,
            args: [...cols.map((c) => (vals[c] ?? null) as string | number | null), hash, now],
          };
        }),
        "write",
      );
      inserted += res.reduce((s, r) => s + r.rowsAffected, 0);
    }
    console.log(JSON.stringify({ mode: "apply", planned: plan.links.length, inserted }));
    return;
  }

  // 1) 대상: 모양이 안 붙은 주거 동이 있는 단지 (read.ts와 같은 연결 규칙으로 계산)
  const cxRows = (
    await db.execute(
      `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd, m.bjdong_cd, m.jibun,
              COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
       FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
       WHERE m.complex_id IN (SELECT DISTINCT complex_id FROM complex_buildings)`,
    )
  ).rows;
  const cxById = new Map(cxRows.filter((m) => m.lat != null).map((m) => [String(m.complex_id), m]));
  const cbRows = (
    await db.execute(
      `SELECT complex_id, building_id, mgm_bldrgst_pk, dong_label, building_name, floor_count, residential_flag
       FROM complex_buildings WHERE length(mgm_bldrgst_pk) > 5`,
    )
  ).rows;
  const gisRows = (
    await db.execute(
      `SELECT bldrgst_pk, lawd_cd, lat, lng, (rings IS NOT NULL AND rings <> 'null') AS has_rings
       FROM gis_buildings WHERE bldrgst_pk IS NOT NULL`,
    )
  ).rows;
  const gisByKey = new Map<string, Array<{ lat: number; lng: number; has: boolean }>>();
  for (const g of gisRows) {
    const k = `${g.lawd_cd}|${g.bldrgst_pk}`;
    (gisByKey.get(k) ?? gisByKey.set(k, []).get(k)!).push({ lat: Number(g.lat), lng: Number(g.lng), has: Number(g.has_rings) === 1 });
  }
  /** 0: 번호 GIS 행이 1km 안에 없음(채울 수 있음), 1: 모양 붙음, 2: 1km 안에 행은 있는데 모양 없음 */
  const linkState = (b: Record<string, unknown>): 0 | 1 | 2 => {
    const m = cxById.get(String(b.complex_id));
    if (!m) return 0;
    const near = (gisByKey.get(`${m.lawd_cd}|${String(b.mgm_bldrgst_pk).slice(5)}`) ?? []).filter(
      (g) => !Number.isFinite(g.lat) || haversine(Number(m.lat), Number(m.lng), g.lat, g.lng) <= LINK_MAX_M,
    );
    if (!near.length) return 0;
    return near.some((g) => g.has) ? 1 : 2;
  };
  const cbByCx = new Map<string, Array<Record<string, unknown> & { state: 0 | 1 | 2 }>>();
  let resTotal = 0;
  let resLinked = 0;
  for (const b of cbRows) {
    const st = linkState(b);
    if (Number(b.residential_flag) === 1) {
      resTotal++;
      if (st === 1) resLinked++;
    }
    const k = String(b.complex_id);
    (cbByCx.get(k) ?? cbByCx.set(k, []).get(k)!).push({ ...b, state: st });
  }
  let targets = [...cbByCx.entries()]
    .filter(([cid, bs]) => cxById.has(cid) && bs.some((b) => Number(b.residential_flag) === 1 && b.state === 0))
    .map(([cid, bs]) => ({ cid, missing: bs.filter((b) => Number(b.residential_flag) === 1 && b.state === 0).length }))
    .sort((a, b) => b.missing - a.missing);
  const before = {
    residential_buildings: resTotal,
    residential_with_shape: resLinked,
    target_complexes: targets.length,
    target_residential_buildings: targets.reduce((s, t) => s + t.missing, 0),
  };
  console.log(JSON.stringify({ before }));
  if (onlyComplexes.length) targets = targets.filter((t) => onlyComplexes.includes(t.cid));
  if (limit) targets = targets.slice(0, limit);

  // 2) 도형 받기 (캐시)
  const key = process.env.VWORLD_API_KEY?.trim();
  if (!key && !noFetch) throw new Error("VWORLD_API_KEY 없음");
  const featsByCx = new Map<string, Feature[]>();
  let fetched = 0;
  let stopped: string | null = null;
  for (const t of targets) {
    const m = cxById.get(t.cid)!;
    const path = join(CACHE, `${t.cid}.json`);
    if (noFetch || stopped) {
      if (existsSync(path)) featsByCx.set(t.cid, JSON.parse(readFileSync(path, "utf8")) as Feature[]);
      continue;
    }
    try {
      const wasCached = existsSync(path);
      featsByCx.set(t.cid, await fetchComplex(key!, t.cid, Number(m.lat), Number(m.lng)));
      if (!wasCached && ++fetched % 50 === 0) console.log(`  받음 ${fetched}단지 (${featsByCx.size}/${targets.length})`);
    } catch (e) {
      if (!(e instanceof StopFetch)) throw e;
      stopped = e.message.replaceAll(key!, "<KEY>");
      console.log(`브이월드 받기 멈춤: ${stopped} — 캐시된 것만으로 계획을 만든다. 다시 돌리면 이어 받는다.`);
    }
  }

  // 3) 짝 찾기
  const skipped: Record<string, number> = {};
  const skip = (why: string, n = 1) => (skipped[why] = (skipped[why] ?? 0) + n);
  const floorMismatch: unknown[] = [];
  const cand: Link[] = [];
  const parcelCache: Record<string, string> = existsSync(PARCEL_CACHE) ? JSON.parse(readFileSync(PARCEL_CACHE, "utf8")) : {};
  // 단지 대표 지번
  const cxParcels = new Map<string, Set<string>>();
  for (const t of targets) {
    const m = cxById.get(t.cid)!;
    const set = new Set<string>();
    const mk = parcelKey(`${m.lawd_cd}${m.bjdong_cd ?? ""}`, String(m.jibun ?? ""));
    if (mk) set.add(mk);
    cxParcels.set(t.cid, set);
  }
  for (const part of chunks(targets.map((t) => t.cid), 300)) {
    const r = await db.execute({
      sql: `SELECT complex_id, parcel_key FROM complex_building_checkpoint WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const x of r.rows) {
      const [lawd, bj, san, bun, ji] = String(x.parcel_key ?? "").split("|");
      if (san !== "0" || !bun) continue;
      const k = parcelKey(`${lawd}${bj}`, `${Number(bun)}-${Number(ji ?? 0)}`);
      if (k) cxParcels.get(String(x.complex_id))?.add(k);
    }
  }
  let geocoded = 0;
  const parcelOf = async (f: Feature): Promise<string | null> => {
    if (f.bd_mgt_sn in parcelCache) return parcelCache[f.bd_mgt_sn]!;
    if (noFetch || stopped) return null;
    try {
      parcelCache[f.bd_mgt_sn] = await pointParcel(key!, f.lng, f.lat);
      if (++geocoded % 200 === 0) writeFileSync(PARCEL_CACHE, JSON.stringify(parcelCache));
      return parcelCache[f.bd_mgt_sn]!;
    } catch (e) {
      if (!(e instanceof StopFetch)) throw e;
      stopped = e.message.replaceAll(key!, "<KEY>");
      console.log(`역지오코딩 멈춤: ${stopped}`);
      return null;
    }
  };
  for (const t of targets) {
    const feats = featsByCx.get(t.cid);
    if (!feats) {
      skip("complex_not_fetched");
      continue;
    }
    const m = cxById.get(t.cid)!;
    const cxNames = [norm(m.apt_name), norm(m.apt_name_norm)];
    const bs = cbByCx.get(t.cid)!.filter((b) => b.state === 0);
    // 같은 도로명주소 안에서 동 표기가 둘 이상이면 도로명주소 규칙에 쓰지 않는다
    const dkCountByRoad = new Map<string, number>();
    for (const f of feats) {
      const dk = splitSpbdDong(f.buld_nm_dc)[1];
      if (f.road && dk) dkCountByRoad.set(`${f.road}#${dk}`, (dkCountByRoad.get(`${f.road}#${dk}`) ?? 0) + 1);
    }
    const anchors = new Set<string>();
    const unnamed: Array<{ f: Feature; dk: string; d: number; sameDong: typeof bs }> = [];
    const push = (f: Feature, b: (typeof bs)[number], d: number, rule: Link["rule"]) => {
      if (f.road) anchors.add(f.road);
      cand.push({
        bld_key: `SPBD:${f.bd_mgt_sn}`,
        bldrgst_pk: String(b.mgm_bldrgst_pk).slice(5),
        lawd_cd: String(m.lawd_cd),
        complex_id: t.cid,
        apt_name: String(m.apt_name),
        building_id: String(b.building_id),
        dong_label: String(b.dong_label),
        spbd_label: `${f.buld_nm} / ${f.buld_nm_dc}`,
        floors_spbd: f.gro_flo_co,
        floors_ledger: num(b.floor_count),
        dist_m: Math.round(d),
        rule,
        feature: f,
      });
    };
    // (1) 이름
    for (const f of feats) {
      const d = haversine(Number(m.lat), Number(m.lng), f.lat, f.lng);
      if (d > LINK_MAX_M) continue;
      const [pd, dk] = splitSpbdDong(f.buld_nm_dc);
      if (!dk) continue;
      const sameDong = bs.filter((b) => dongKey(b.dong_label) === dk);
      if (!sameDong.length) continue;
      const prefixes = [norm(f.buld_nm), pd].filter((p) => p.length >= 2);
      if (!prefixes.length) {
        unnamed.push({ f, dk, d, sameDong });
        continue;
      }
      for (const b of sameDong) {
        const names = new Set([...cxNames, norm(b.building_name)].filter(Boolean));
        if (prefixes.every((p) => names.has(p))) push(f, b, d, "name");
      }
    }
    // (2) 이름 없는 건물 — 이 단지에 붙은 건물과 같은 도로명주소(그 안에서 동 표기 유일), 아니면 지번이 단지 대표 지번과 같을 때
    const viaRoad = (u: (typeof unnamed)[number]) =>
      !!u.f.road && anchors.has(u.f.road) && dkCountByRoad.get(`${u.f.road}#${u.dk}`) === 1;
    let rest: typeof unnamed = [];
    for (const u of unnamed) {
      if (viaRoad(u)) for (const b of u.sameDong) push(u.f, b, u.d, "road_address");
      else rest.push(u);
    }
    const cps = cxParcels.get(t.cid)!;
    const rest2: typeof unnamed = [];
    for (const u of rest) {
      const pk = cps.size ? await parcelOf(u.f) : null;
      if (pk && cps.has(pk)) for (const b of u.sameDong) push(u.f, b, u.d, "parcel");
      else rest2.push(u);
    }
    rest = [];
    for (const u of rest2) {
      if (viaRoad(u)) for (const b of u.sameDong) push(u.f, b, u.d, "road_address");
      else rest.push(u);
    }
    for (const u of rest) {
      if (!cps.size) skip("unnamed_spbd_complex_has_no_parcel");
      else if (!(u.f.bd_mgt_sn in parcelCache)) skip("unnamed_spbd_parcel_not_fetched");
      else skip("unnamed_spbd_other_parcel_and_road");
    }
  }
  writeFileSync(PARCEL_CACHE, JSON.stringify(parcelCache));
  // 같은 (건물, 동) 짝이 여러 단지 캐시에서 겹쳐 나온 것은 하나로
  const uniq = new Map<string, Link>();
  for (const c of cand) uniq.set(`${c.bld_key}|${c.building_id}`, c);
  const perFeature = new Map<string, number>();
  const perBuilding = new Map<string, number>();
  for (const c of uniq.values()) {
    perFeature.set(c.bld_key, (perFeature.get(c.bld_key) ?? 0) + 1);
    perBuilding.set(c.building_id, (perBuilding.get(c.building_id) ?? 0) + 1);
  }
  const links: Link[] = [];
  for (const c of uniq.values()) {
    if (perFeature.get(c.bld_key)! > 1) {
      skip("spbd_matches_2+_buildings");
      continue;
    }
    if (perBuilding.get(c.building_id)! > 1) {
      skip("building_matched_by_2+_spbd");
      continue;
    }
    if (c.floors_spbd && c.floors_ledger && Math.abs(c.floors_spbd - c.floors_ledger) > FLOOR_TOL) {
      skip("floor_count_differs");
      floorMismatch.push({ ...c, feature: undefined });
      continue;
    }
    links.push(c);
  }
  // 이미 DB에 같은 bld_key가 있으면 건너뜀 (INSERT OR IGNORE와 같은 결과, 수를 미리 보기 위함)
  const existingKeys = new Set<string>();
  for (const part of chunks(links.map((l) => l.bld_key), 200)) {
    const r = await db.execute({ sql: `SELECT bld_key FROM gis_buildings WHERE bld_key IN (${part.map(() => "?").join(",")})`, args: part });
    for (const x of r.rows) existingKeys.add(String(x.bld_key));
  }
  const finalLinks = links.filter((l) => {
    if (existingKeys.has(l.bld_key)) {
      skip("bld_key_already_in_db");
      return false;
    }
    return true;
  });

  const unlinkedRes = targets.reduce((s, t) => s + t.missing, 0);
  const byComplex: Record<string, { linked: number; missing: number }> = {};
  for (const t of targets) byComplex[t.cid] = { linked: 0, missing: t.missing };
  for (const l of finalLinks) byComplex[l.complex_id]!.linked++;
  const resLinkIds = new Set(
    finalLinks.filter((l) => cbByCx.get(l.complex_id)!.find((b) => b.building_id === l.building_id && Number(b.residential_flag) === 1)).map((l) => l.building_id),
  );
  const summary = {
    mode: "dry-run",
    source: "VWorld 2D 데이터 API LT_C_SPBD (도로명주소 건물)",
    targets: targets.length,
    fetched_complexes: featsByCx.size,
    fetch_stopped: stopped,
    target_residential_buildings: unlinkedRes,
    links: finalLinks.length,
    links_by_rule: Object.fromEntries(
      (["name", "road_address", "parcel"] as const).map((r) => [r, finalLinks.filter((l) => l.rule === r).length]),
    ),
    reverse_geocoded: geocoded,
    residential_links: resLinkIds.size,
    complexes_with_links: Object.values(byComplex).filter((x) => x.linked).length,
    complexes_fully_covered: targets.filter((t) => {
      const ids = new Set(cbByCx.get(t.cid)!.filter((b) => Number(b.residential_flag) === 1 && b.state === 0).map((b) => String(b.building_id)));
      return [...ids].every((id) => resLinkIds.has(id));
    }).length,
    skipped,
    after_if_applied: { residential_with_shape: before.residential_with_shape + resLinkIds.size, residential_buildings: before.residential_buildings },
  };
  writeFileSync(
    planPath,
    JSON.stringify({ built_at: new Date().toISOString(), source_date: new Date().toISOString().slice(0, 10), summary, links: finalLinks, floorMismatch }),
  );
  console.log(JSON.stringify({ ...summary, plan: planPath }, null, 1));
  const sample = [...finalLinks].sort(() => Math.random() - 0.5).slice(0, 20);
  for (const s of sample)
    console.log(`${s.apt_name} ${s.dong_label} (${s.floors_ledger}F) ← SPBD "${s.spbd_label}" (${s.floors_spbd}F) ${s.dist_m}m [${s.rule}]`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e).replaceAll(process.env.VWORLD_API_KEY?.trim() || "\u0000", "<KEY>"));
  process.exit(1);
});
