/**
 * 3D 단지 탐색 데이터 — 단지 동(건축HUB 표제부, complex_buildings) + 건물 모양·높이(GIS건물통합정보, gis_buildings)
 * + 주변 건물(반경 500m) + 층별 시세(실거래) + 주변 학교·역.
 * 읽기 전용. 동 ↔ GIS 건물 연결: 같은 시·군·구에서 건축물대장 번호(앞 5자리 기관코드 제외)가 정확히 같을 때만.
 * 값은 원천 그대로 — 높이가 없으면 null (화면에서 층수로 그리고 그렇게 표기한다).
 */
import type { Client } from "@libsql/client";
import { aptDetailHref } from "@/lib/molit/apt-client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { readNearbyRailStations } from "@/lib/transit/rail-stations";

export type Ring = Array<[number, number]>; // [lng, lat]

export type Complex3dBuilding = {
  id: string;
  dong: string | null;
  name: string | null;
  usage: string | null;
  residential: boolean;
  households: number | null;
  floors: number | null;
  floorsBelow: number | null;
  heightM: number | null;
  approvalDate: string | null;
  /** 동별 평형 구성 (건축HUB 전유부 기준) */
  units: Array<{ label: string; households: number }>;
  /** 외곽선 — GIS 건물과 연결되지 않으면 null */
  rings: Ring[] | null;
};

export type Neighbor3d = {
  id: string;
  name: string | null;
  usage: string | null;
  heightM: number | null;
  floors: number | null;
  rings: Ring[];
};

export type FloorBand = {
  label: string;
  fromFloor: number;
  toFloor: number;
  count: number;
  /** 전용 3.3㎡당 중위가 (만원) */
  perPyeong: number | null;
};

export type Poi3d = {
  kind: "school" | "station";
  name: string;
  sub: string | null;
  lat: number;
  lng: number;
  distanceM: number;
};

export type Complex3d = {
  complexId: string;
  name: string;
  place: string;
  href: string;
  center: { lat: number; lng: number };
  buildings: Complex3dBuilding[];
  neighbors: Neighbor3d[];
  floorBands: FloorBand[];
  floorBandsBasis: string;
  pois: Poi3d[];
  coverage: { buildings: number; withShape: number };
};

const RADIUS_M = 500;
const A_LINK_MAX_M = 1000;
const PYEONG = 3.3058;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export async function readComplex3d(db: Client, complexId: string): Promise<Complex3d | null> {
  const mres = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, m.sigungu,
                 COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
          FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
          WHERE m.complex_id = ?`,
    args: [complexId],
  });
  const m = mres.rows[0];
  if (!m || m.lat == null) return null;
  const lawd = String(m.lawd_cd);
  const center = { lat: Number(m.lat), lng: Number(m.lng) };
  const gu = (m.sigungu ? String(m.sigungu).split(/\s+/).pop() : null) || districtNameFromCode(lawd);
  const reg = LAWD_TO_REGION[lawd];

  const [cbRes, unitRes] = await Promise.all([
    db.execute({
      sql: `SELECT building_id, mgm_bldrgst_pk, dong_label, building_name, main_usage, residential_flag,
                   household_count, floor_count, underground_floor_count, height_m
            FROM complex_buildings WHERE complex_id = ?`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT l.building_id, l.household_count, u.display_pyeong_label, u.exclusive_area
            FROM unit_type_building_links l
            JOIN apt_canonical_unit_types u ON u.unit_type_id = l.unit_type_id
            WHERE l.complex_id = ?`,
      args: [complexId],
    }),
  ]);

  const suffixes = cbRes.rows
    .map((r) => String(r.mgm_bldrgst_pk ?? ""))
    .filter((pk) => pk.length > 5)
    .map((pk) => pk.slice(5));
  const gisByPk = new Map<string, Record<string, unknown>>();
  if (suffixes.length) {
    const g = await db.execute({
      sql: `SELECT bld_key, bldrgst_pk, height_m, floors_above, floors_below, approval_date, rings, lat, lng
            FROM gis_buildings WHERE lawd_cd = ? AND bldrgst_pk IN (${suffixes.map(() => "?").join(",")})`,
      args: [lawd, ...suffixes],
    });
    // 건축물대장 번호는 옛 시군구마다 따로 매긴 짧은 일련번호라, 합쳐진 구에서는 같은 번호의 먼 건물이 있다 —
    // 단지 좌표에서 1km 안인 건물만 동 모양으로 쓴다 (적재 규칙과 같음)
    for (const r of g.rows) {
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && haversine(center.lat, center.lng, lat, lng) > A_LINK_MAX_M) continue;
      gisByPk.set(String(r.bldrgst_pk), r as Record<string, unknown>);
    }
  }

  const unitsByBuilding = new Map<string, Array<{ label: string; households: number }>>();
  for (const r of unitRes.rows) {
    const k = String(r.building_id);
    const label = str(r.display_pyeong_label) ?? (r.exclusive_area != null ? `전용 ${Math.round(Number(r.exclusive_area))}㎡` : "기타");
    const list = unitsByBuilding.get(k) ?? [];
    const hit = list.find((x) => x.label === label);
    if (hit) hit.households += Number(r.household_count ?? 0);
    else list.push({ label, households: Number(r.household_count ?? 0) });
    unitsByBuilding.set(k, list);
  }

  const ownKeys = new Set<string>();
  const buildings: Complex3dBuilding[] = cbRes.rows.map((r) => {
    const pk = String(r.mgm_bldrgst_pk ?? "");
    const gis = pk.length > 5 ? gisByPk.get(pk.slice(5)) : undefined;
    if (gis) ownKeys.add(String(gis.bld_key));
    return {
      id: String(r.building_id),
      dong: str(r.dong_label),
      name: str(r.building_name),
      usage: str(r.main_usage),
      residential: Number(r.residential_flag) === 1,
      households: num(r.household_count),
      floors: num(r.floor_count) ?? num(gis?.floors_above),
      floorsBelow: num(r.underground_floor_count) ?? num(gis?.floors_below),
      heightM: num(r.height_m) ?? num(gis?.height_m),
      approvalDate: str(gis?.approval_date),
      units: (unitsByBuilding.get(String(r.building_id)) ?? []).sort((a, b) => b.households - a.households),
      rings: gis ? (JSON.parse(String(gis.rings)) as Ring[]) : null,
    };
  });

  // 주변 건물 (반경 RADIUS_M 사각형)
  const dLat = RADIUS_M / 111_320;
  const dLng = RADIUS_M / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const nres = await db.execute({
    sql: `SELECT bld_key, name, use_name, height_m, floors_above, rings FROM gis_buildings
          WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 2500`,
    args: [center.lat - dLat, center.lat + dLat, center.lng - dLng, center.lng + dLng],
  });
  const neighbors: Neighbor3d[] = nres.rows
    .filter((r) => !ownKeys.has(String(r.bld_key)))
    .map((r) => ({
      id: String(r.bld_key),
      name: str(r.name),
      usage: str(r.use_name),
      heightM: num(r.height_m),
      floors: num(r.floors_above),
      rings: JSON.parse(String(r.rings)) as Ring[],
    }));

  // 층별 시세 — 최근 3년 매매, 최고층을 3등분 (저·중·고), 전용 3.3㎡당 중위가
  const since = `${new Date().getFullYear() - 3}${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const tres = await db.execute({
    sql: `SELECT floor, deal_amount, exclusive_area FROM transactions
          WHERE lawd_cd = ? AND apt_name_norm = ? AND deal_type = 'trade' AND year_month >= ?
            AND deal_amount > 0 AND exclusive_area > 0 AND floor IS NOT NULL`,
    args: [lawd, String(m.apt_name_norm), since],
  });
  const deals = tres.rows
    .map((r) => ({ floor: Number(r.floor), ppp: Number(r.deal_amount) / (Number(r.exclusive_area) / PYEONG) }))
    .filter((d) => d.floor > 0 && Number.isFinite(d.ppp));
  const maxFloor = Math.max(0, ...buildings.map((b) => b.floors ?? 0), ...deals.map((d) => d.floor));
  const floorBands: FloorBand[] = [];
  if (maxFloor >= 3) {
    const a = Math.round(maxFloor / 3);
    const b = Math.round((maxFloor * 2) / 3);
    const bands: Array<[string, number, number]> = [
      ["저층", 1, a],
      ["중층", a + 1, b],
      ["고층", b + 1, maxFloor],
    ];
    for (const [label, from, to] of bands) {
      const sel = deals.filter((d) => d.floor >= from && d.floor <= to);
      const med = median(sel.map((d) => d.ppp));
      floorBands.push({ label, fromFloor: from, toFloor: to, count: sel.length, perPyeong: med == null ? null : Math.round(med) });
    }
  }

  // 주변 학교 · 역
  const pois: Poi3d[] = [];
  const sres = await db.execute({
    sql: `SELECT s.school_name, s.school_level, s.lat, s.lng, n.distance_m
          FROM complex_nearby_schools n JOIN school_master s ON s.school_code = n.school_code
          WHERE n.complex_id = ? AND s.lat IS NOT NULL ORDER BY n.distance_m LIMIT 8`,
    args: [complexId],
  });
  for (const r of sres.rows) {
    pois.push({
      kind: "school",
      name: String(r.school_name),
      sub: str(r.school_level),
      lat: Number(r.lat),
      lng: Number(r.lng),
      distanceM: Math.round(Number(r.distance_m ?? haversine(center.lat, center.lng, Number(r.lat), Number(r.lng)))),
    });
  }
  for (const st of await readNearbyRailStations(db, center, { maxMeters: 1200, limit: 4 })) {
    pois.push({ kind: "station", name: st.name, sub: st.lines.join("·"), lat: st.lat, lng: st.lng, distanceM: st.distanceMeters });
  }

  return {
    complexId,
    name: String(m.apt_name),
    place: [reg?.name ?? gu, str(m.legal_dong_name)].filter(Boolean).join(" "),
    href: aptDetailHref(String(m.apt_name), reg?.slug ?? slugFromLawd("", lawd), gu || undefined),
    center,
    buildings,
    neighbors,
    floorBands,
    floorBandsBasis: `최근 3년 매매 ${deals.length}건`,
    pois,
    coverage: { buildings: buildings.length, withShape: buildings.filter((b) => b.rings).length },
  };
}
