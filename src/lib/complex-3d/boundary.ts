/**
 * 단지 경계 — 서울 3D 지도에서 단지를 골랐을 때 그리는 대지 외곽선.
 *
 * 1순위: 연속지적도(브이월드 데이터 API LP_PA_CBND_BUBUN) 필지 — 단지의 PNU(대표 필지 complex_parcel_coordinates,
 *        GIS 건물의 pnu, 마스터 법정동·지번)로 한 필지씩 부르고, 단지 동이 들어 있는 필지만 남긴다.
 *        동 일부가 그 필지 밖이면 동 범위 상자(BOX)로 한 번 더 불러 동이 서 있는 필지를 더한다.
 * 2순위(필지가 없을 때): 단지 동 외곽선을 감싼 볼록 껍질을 조금 넓힌 것 — 추정 경계 (source "estimated").
 *
 * 한 단지 요청에 한 단지 도형만 (여러 단지를 한꺼번에 주는 길은 만들지 않는다). 결과는 complex_site_boundary에
 * 한 줄로 저장해 브이월드를 다시 부르지 않는다 (없으면 처음 저장할 때 만든다 — 더하기만 하는 표).
 */
import type { Client } from "@libsql/client";
import { readComplex3d, type Ring } from "@/lib/complex-3d/read";
import { groupMemberIds } from "@/lib/complex-group/groups";

export type SiteBoundary = {
  complexId: string;
  source: "parcel" | "estimated";
  pnus: string[];
  /** 채우기 — 필지(또는 추정 껍질) 도형 */
  fill: GeoJSON.MultiPolygon;
  /** 외곽선 — 이웃 필지와 겹치는 변은 뺀 바깥 둘레만 */
  outline: GeoJSON.MultiLineString;
  /** [서, 남, 동, 북] */
  bbox: [number, number, number, number];
};

type Poly = Ring[]; // [외곽, 구멍…]
type Parcel = { pnu: string; jibun: string; polys: Poly[] };

const TABLE = "complex_site_boundary";
/** 필지 결과는 오래 쓴다 (지적도는 거의 안 바뀜). 추정 경계는 한 달 뒤 다시 확인 */
const PARCEL_TTL_DAYS = 180;
const ESTIMATE_TTL_DAYS = 30;
const MAX_PNUS = 6;
/** 동 범위 상자 조회 한도 — 이보다 넓은 단지는 상자 조회를 하지 않는다 (필지 수가 너무 많아짐) */
const MAX_BOX_DEG = 0.015;
/** 상자 조회에서 빼는 지목 — 도로·하천·구거·제방 (동 중심점이 여기 걸리는 건 도형 오차) */
const SKIP_JIMOK = /(도|천|구|제)$/;
const HULL_PAD_M = 8;
const DOMAIN = process.env.VWORLD_DOMAIN?.trim() || "https://actual-transaction-data.vercel.app";

function vworldKey(): string | null {
  return process.env.VWORLD_API_KEY?.trim() || process.env.VWORLD_KEY?.trim() || null;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolys(x: number, y: number, polys: Poly[]): boolean {
  return polys.some(([outer, ...holes]) => !!outer && pointInRing(x, y, outer) && !holes.some((h) => pointInRing(x, y, h)));
}

/** 동 외곽선의 대표점 (꼭짓점 평균 — 동 모양은 대개 볼록에 가깝다) */
function ringCenter(r: Ring): [number, number] {
  const pts = r.length > 1 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1] ? r.slice(0, -1) : r;
  let x = 0;
  let y = 0;
  for (const [a, b] of pts) {
    x += a;
    y += b;
  }
  return [x / pts.length, y / pts.length];
}

/** "19" · "913-2" → PNU 뒤 9자리 (일반 1 + 본번 4 + 부번 4). 산 지번·모르는 모양은 null */
function jibunPart(jibun: string | null | undefined): string | null {
  const m = String(jibun ?? "").trim().match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
  if (!m) return null;
  return `1${m[1]!.padStart(4, "0")}${(m[2] ?? "0").padStart(4, "0")}`;
}

type VwFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };

class VworldError extends Error {}

async function vworldParcels(key: string, filter: string): Promise<Parcel[]> {
  const url =
    `https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&data=LP_PA_CBND_BUBUN&format=json` +
    `&geometry=true&attribute=true&crs=EPSG:4326&size=1000&page=1&${filter}&key=${key}&domain=${encodeURIComponent(DOMAIN)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
  } catch (e) {
    throw new VworldError(`network ${(e as Error).name}`);
  }
  if (!res.ok) throw new VworldError(`HTTP ${res.status}`);
  const j = (await res.json()) as {
    response?: { status?: string; error?: { code?: string }; result?: { featureCollection?: { features?: VwFeature[] } } };
  };
  const r = j.response;
  if (r?.status === "NOT_FOUND") return [];
  if (r?.status !== "OK") throw new VworldError(r?.error?.code ?? String(r?.status));
  const out: Parcel[] = [];
  for (const f of r.result?.featureCollection?.features ?? []) {
    const g = f.geometry;
    const polys =
      g.type === "MultiPolygon" ? (g.coordinates as Poly[]) : g.type === "Polygon" ? [g.coordinates as Poly] : [];
    if (!polys.length) continue;
    out.push({
      pnu: String(f.properties.pnu ?? ""),
      jibun: String(f.properties.jibun ?? ""),
      polys: polys.map((p) => p.map((ring) => ring.map(([x, y]) => [round6(x), round6(y)] as [number, number]))),
    });
  }
  return out;
}

/** 필지들의 바깥 둘레 — 두 필지가 같이 쓰는 변(같은 두 꼭짓점)은 빼고, 이어지는 변끼리 한 줄로 */
function outlineOf(polys: Poly[]): GeoJSON.MultiLineString {
  const k = (a: [number, number], b: [number, number]) => {
    const p = `${a[0]},${a[1]}`;
    const q = `${b[0]},${b[1]}`;
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  const count = new Map<string, number>();
  for (const poly of polys)
    for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) count.set(k(ring[i]!, ring[i + 1]!), (count.get(k(ring[i]!, ring[i + 1]!)) ?? 0) + 1);
  const lines: Array<Array<[number, number]>> = [];
  for (const poly of polys)
    for (const ring of poly) {
      const own: Array<Array<[number, number]>> = [];
      let cur: Array<[number, number]> | null = null;
      const n = ring.length - 1;
      for (let i = 0; i < n; i++) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        if ((count.get(k(a, b)) ?? 0) > 1) {
          cur = null;
          continue;
        }
        if (!cur) {
          cur = [a];
          own.push(cur);
        }
        cur.push(b);
      }
      // 첫 변과 끝 변이 둘 다 남았으면 (고리가 이어지는 곳) 끝 줄 뒤에 첫 줄을 붙여 한 줄로
      const firstKept = n > 0 && (count.get(k(ring[0]!, ring[1]!)) ?? 0) <= 1;
      const lastKept = n > 0 && (count.get(k(ring[n - 1]!, ring[n]!)) ?? 0) <= 1;
      if (own.length >= 2 && firstKept && lastKept) {
        const first = own.shift()!;
        own[own.length - 1]!.push(...first.slice(1));
      }
      lines.push(...own);
    }
  return { type: "MultiLineString", coordinates: lines };
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** 볼록 껍질 (Andrew) — 닫힌 고리로 */
function convexHull(points: Array<[number, number]>): Ring {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return [];
  const lower: Array<[number, number]> = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return [...hull, hull[0]!];
}

/**
 * 추정 경계 — 동 외곽선 꼭짓점마다 반경 HULL_PAD_M 원(8점)을 둘러 볼록 껍질을 만든다 (동 외곽선 + 여유).
 * 실제 대지 경계가 아니다 (지적도 필지를 못 찾았을 때만).
 */
function estimatedHull(rings: Ring[], lat: number): Ring {
  const dLat = HULL_PAD_M / 111_320;
  const dLng = HULL_PAD_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  const pts: Array<[number, number]> = [];
  for (const r of rings)
    for (const [x, y] of r)
      for (let i = 0; i < 8; i++) {
        const t = (i * Math.PI) / 4;
        pts.push([round6(x + Math.cos(t) * dLng), round6(y + Math.sin(t) * dLat)]);
      }
  return convexHull(pts);
}

function bboxOf(polys: Poly[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys)
    for (const [x, y] of poly[0] ?? []) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  return b;
}

function build(complexId: string, source: SiteBoundary["source"], pnus: string[], polys: Poly[]): SiteBoundary {
  return {
    complexId,
    source,
    pnus,
    fill: { type: "MultiPolygon", coordinates: polys },
    outline: outlineOf(polys),
    bbox: bboxOf(polys),
  };
}

async function readCached(db: Client, complexId: string): Promise<SiteBoundary | null> {
  try {
    const r = await db.execute({
      sql: `SELECT source, pnus, polys, fetched_at FROM ${TABLE} WHERE complex_id = ?`,
      args: [complexId],
    });
    const row = r.rows[0];
    if (!row) return null;
    const source = String(row.source) === "parcel" ? "parcel" : "estimated";
    const ageDays = (Date.now() - Date.parse(String(row.fetched_at))) / 86_400_000;
    if (!(ageDays < (source === "parcel" ? PARCEL_TTL_DAYS : ESTIMATE_TTL_DAYS))) return null;
    return build(complexId, source, JSON.parse(String(row.pnus)) as string[], JSON.parse(String(row.polys)) as Poly[]);
  } catch {
    return null; // 표가 아직 없음 등 — 새로 만든다
  }
}

async function writeCached(db: Client, b: SiteBoundary): Promise<void> {
  const stmt = {
    sql: `INSERT OR REPLACE INTO ${TABLE} (complex_id, source, pnus, polys, fetched_at) VALUES (?, ?, ?, ?, ?)`,
    args: [b.complexId, b.source, JSON.stringify(b.pnus), JSON.stringify(b.fill.coordinates), new Date().toISOString()],
  };
  try {
    await db.execute(stmt);
  } catch (e) {
    if (!/no such table/i.test(String((e as Error).message))) throw e;
    await db.execute(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         complex_id TEXT PRIMARY KEY,
         source TEXT NOT NULL,
         pnus TEXT NOT NULL,
         polys TEXT NOT NULL,
         fetched_at TEXT NOT NULL
       )`,
    );
    await db.execute(stmt);
  }
}

/**
 * 경계가 지도 마커(단지 좌표) 근처에 있는지 — 약 100m 여유. 재건축 등으로 마스터 지번이 옛 작은 필지를 가리키면
 * 엉뚱한 곳에 작은 경계가 그려지므로(예: 힐스테이트마포더퍼스트) 그런 경계는 쓰지 않는다.
 */
function nearAnchor(b: SiteBoundary, lat: number, lng: number): boolean {
  const [x0, y0, x1, y1] = b.bbox;
  return lng >= x0 - 0.0012 && lng <= x1 + 0.0012 && lat >= y0 - 0.0009 && lat <= y1 + 0.0009;
}

async function anchorOf(db: Client, complexId: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await db.execute({
      sql: `SELECT COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
            FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
            WHERE m.complex_id = ?`,
      args: [complexId],
    });
    const row = r.rows[0];
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 ? { lat, lng } : null;
  } catch {
    return null;
  }
}

/**
 * 단지 경계 한 개. 단지를 모르면 null. 브이월드가 잠시 안 되면 추정 경계를 주되 저장하지 않는다.
 * 단지 묶음(complex_group)이면 멤버마다 따로 만든(저장된) 경계를 합친다 — 같은 필지 도형은 한 번만.
 */
export async function readSiteBoundary(db: Client, complexId: string): Promise<SiteBoundary | null> {
  const ids = await groupMemberIds(db, complexId);
  if (ids.length < 2) return readOneSiteBoundary(db, complexId);
  const parts = (await Promise.all(ids.map((id) => readOneSiteBoundary(db, id)))).filter((b): b is SiteBoundary => !!b);
  if (!parts.length) return null;
  const seen = new Set<string>();
  const polys: Poly[] = [];
  for (const b of parts)
    for (const poly of b.fill.coordinates as Poly[]) {
      const k = JSON.stringify(poly);
      if (seen.has(k)) continue;
      seen.add(k);
      polys.push(poly);
    }
  const pnus = [...new Set(parts.flatMap((b) => b.pnus))];
  return build(complexId, parts.every((b) => b.source === "parcel") ? "parcel" : "estimated", pnus, polys);
}

async function readOneSiteBoundary(db: Client, complexId: string): Promise<SiteBoundary | null> {
  const [cached, anchor] = await Promise.all([readCached(db, complexId), anchorOf(db, complexId)]);
  if (cached && (!anchor || nearAnchor(cached, anchor.lat, anchor.lng))) return cached;

  const [shape, meta] = await Promise.all([
    readComplex3d(db, complexId, { shapesOnly: true, group: false }),
    db.batch(
      [
        { sql: `SELECT lawd_cd, bjdong_cd, jibun FROM apt_complex_master WHERE complex_id = ?`, args: [complexId] },
        { sql: `SELECT pnu FROM complex_parcel_coordinates WHERE complex_id = ? AND pnu IS NOT NULL`, args: [complexId] },
      ],
      "read",
    ),
  ]);
  if (!shape) return null;
  const [mRows, cpcRows] = meta.map((r) => r.rows);
  const m = mRows![0];

  // 후보 PNU — 대표 필지 → 마스터 지번 (동 모양 행의 pnu는 아래 gisPnus로)
  const cands: string[] = [];
  const add = (p: unknown) => {
    const s = String(p ?? "");
    if (/^\d{19}$/.test(s) && !cands.includes(s)) cands.push(s);
  };
  for (const r of cpcRows ?? []) add(r.pnu);
  if (m) {
    const jp = jibunPart(m.jibun as string | null);
    if (jp && /^\d{5}$/.test(String(m.lawd_cd)) && /^\d{5}$/.test(String(m.bjdong_cd))) add(`${m.lawd_cd}${m.bjdong_cd}${jp}`);
  }
  const gisPnus = await db
    .execute({
      sql: `SELECT DISTINCT pnu FROM gis_buildings
            WHERE lawd_cd = (SELECT lawd_cd FROM apt_complex_master WHERE complex_id = ?)
              AND pnu IS NOT NULL
              AND bldrgst_pk IN (SELECT substr(mgm_bldrgst_pk, 6) FROM complex_buildings WHERE complex_id = ? AND length(mgm_bldrgst_pk) > 5)
            LIMIT ${MAX_PNUS}`,
      args: [complexId, complexId],
    })
    .then((r) => r.rows.map((x) => x.pnu))
    .catch(() => []);
  for (const p of gisPnus) add(p);
  const pnus = cands.slice(0, MAX_PNUS);

  // 단지 동 — 주거동 우선(부대시설이 단지 밖 필지에 있는 경우를 덜 끌어온다), 없으면 전부
  const withRings = shape.buildings.filter((b) => b.rings?.length);
  const resi = withRings.filter((b) => b.residential);
  const bRings = (resi.length ? resi : withRings).flatMap((b) => b.rings!.slice(0, 1));
  const centers = bRings.map(ringCenter);

  const estimate = (): SiteBoundary | null => {
    const all = withRings.flatMap((b) => b.rings!.slice(0, 1));
    if (!all.length) return null;
    const hull = estimatedHull(all, shape.center.lat);
    return hull.length ? build(complexId, "estimated", [], [[hull]]) : null;
  };

  const key = vworldKey();
  if (!key) return estimate();

  let parcels: Parcel[] = [];
  try {
    const got = await Promise.all(pnus.map((p) => vworldParcels(key, `attrFilter=pnu:=:${p}`)));
    const seen = new Set<string>();
    for (const p of got.flat()) {
      if (!p.pnu || seen.has(p.pnu)) continue;
      seen.add(p.pnu);
      parcels.push(p);
    }
    // 동이 서 있는 필지만 (동 모양이 없으면 대표 필지를 그대로)
    if (centers.length) parcels = parcels.filter((p) => centers.some(([x, y]) => pointInPolys(x, y, p.polys)));

    const outside = centers.filter(([x, y]) => !parcels.some((p) => pointInPolys(x, y, p.polys)));
    if (outside.length) {
      const xs = bRings.flatMap((r) => r.map((v) => v[0]));
      const ys = bRings.flatMap((r) => r.map((v) => v[1]));
      const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (b[2]! - b[0]! < MAX_BOX_DEG && b[3]! - b[1]! < MAX_BOX_DEG) {
        const box = b.map((v) => v.toFixed(6)).join(",");
        for (const p of await vworldParcels(key, `geomFilter=BOX(${box})`)) {
          if (seen.has(p.pnu) || SKIP_JIMOK.test(p.jibun)) continue;
          if (!outside.some(([x, y]) => pointInPolys(x, y, p.polys))) continue;
          seen.add(p.pnu);
          parcels.push(p);
        }
      }
    }
  } catch (e) {
    console.warn("[complex-3d/boundary] vworld", complexId, (e as Error).message);
    return estimate(); // 잠시 안 됨 — 저장하지 않는다
  }

  const result = parcels.length
    ? build(
        complexId,
        "parcel",
        parcels.map((p) => p.pnu),
        parcels.flatMap((p) => p.polys),
      )
    : estimate();
  // 마커에서 멀리 떨어진 경계는 잘못 고른 필지 — 그리지 않는다 (저장도 안 함)
  if (result && anchor && !nearAnchor(result, anchor.lat, anchor.lng)) return null;
  if (result) await writeCached(db, result).catch((e) => console.warn("[complex-3d/boundary] cache", (e as Error).message));
  return result;
}
