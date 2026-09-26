/**
 * 걷기 경로 저장·불러오기 (서버 전용). 요청 때 Overpass를 기다리지 않게:
 *  1) complex_walk_routes 에 같은 규칙 버전의 기본 결과가 있으면 그대로
 *  2) 없으면 complex_walk_osm 저장본(OSM 보행망 추출)으로 계산
 *  3) 저장본도 없으면 Overpass 거울 서버를 짧게 차례로 — 성공하면 저장본을 남긴다
 * 기본 출발(단지 가운데 동)의 결과만 저장한다 (동을 고른 요청은 저장본으로 계산만). 쓰기는 단지당 몇 행.
 * 브라우저에는 계산된 경로만 보낸다 — 보행망 원본은 서버 밖으로 나가지 않는다.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { Client } from "@libsql/client";
import { readComplex3d } from "@/lib/complex-3d/read";
import { railStationsBoxStatement, rankNearbyRailStations } from "@/lib/transit/rail-stations";
import { computeWalkRoutes, fetchOverpass, WALK_HW, type OsmEl, type Tags, type WalkInput, type WalkPayload } from "@/lib/complex-3d/walk";
import type { Bbox } from "@/lib/complex-3d/terrain";

/** 경로 계산 규칙이 바뀌면 올린다 — 저장된 결과를 무시하고 다시 계산 */
export const WALK_ROUTES_VERSION = 4;
/** 저장본 형식 */
const OSM_FORMAT = 1;

const WAY_KEYS = [
  "highway", "foot", "access", "sidewalk", "sidewalk:both", "motorroad", "area", "construction", "footway", "path",
  "cycleway", "tunnel", "bridge", "layer", "indoor", "service", "name",
];
const NODE_KEYS = [
  "highway", "crossing", "crossing:signals", "crossing_ref", "railway", "public_transport", "barrier", "entrance", "kerb",
  "wheelchair", "access", "foot", "locked", "name", "ref", "ferry", "amenity", "station", "subway", "bus",
];

function pickTags(t: Tags | undefined, keys: string[]): Tags | undefined {
  if (!t) return undefined;
  const out: Tags = {};
  let any = false;
  for (const k of keys)
    if (t[k] != null) {
      out[k] = t[k]!;
      any = true;
    }
  return any ? out : undefined;
}

/** 걷기에 쓰는 길·점·태그만 남겨 gzip */
export function packOsm(elements: OsmEl[]): Uint8Array {
  const ways: Array<[number, number[], Tags]> = [];
  const used = new Set<number>();
  for (const el of elements) {
    if (el.type !== "way" || !el.nodes || !WALK_HW.has(el.tags?.highway ?? "")) continue;
    ways.push([el.id, el.nodes, pickTags(el.tags, WAY_KEYS) ?? {}]);
    for (const n of el.nodes) used.add(n);
  }
  const nodes = new Map<number, [number, number, number, Tags | 0]>();
  for (const el of elements) {
    if (el.type !== "node") continue;
    const tags = pickTags(el.tags, NODE_KEYS);
    const poi = !!tags && !!(tags.railway || tags.highway === "bus_stop" || tags.public_transport || tags.entrance || tags.highway === "traffic_signals");
    if (!used.has(el.id) && !poi) continue;
    const prev = nodes.get(el.id);
    nodes.set(el.id, [el.id, Math.round(el.lat * 1e7) / 1e7, Math.round(el.lon * 1e7) / 1e7, tags ?? prev?.[3] ?? 0]);
  }
  return gzipSync(JSON.stringify({ v: OSM_FORMAT, n: [...nodes.values()], w: ways }), { level: 9 });
}

export function unpackOsm(buf: Uint8Array): OsmEl[] {
  const j = JSON.parse(gunzipSync(buf).toString("utf8")) as { v: number; n: Array<[number, number, number, Tags | 0]>; w: Array<[number, number[], Tags]> };
  const out: OsmEl[] = [];
  for (const [id, lat, lon, tags] of j.n) out.push({ type: "node", id, lat, lon, ...(tags ? { tags } : {}) });
  for (const [id, nodes, tags] of j.w) out.push({ type: "way", id, nodes, tags });
  return out;
}

const toBytes = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;

async function readOsm(db: Client, complexId: string): Promise<OsmEl[] | null> {
  try {
    const r = await db.execute({
      sql: `SELECT osm_gz FROM complex_walk_osm WHERE complex_id = ? AND format_version = ?`,
      args: [complexId, OSM_FORMAT],
    });
    const b = toBytes(r.rows[0]?.osm_gz);
    return b ? unpackOsm(b) : null;
  } catch {
    return null; // 테이블 없음 등 — 실시간으로
  }
}

export async function storeOsm(db: Client, complexId: string, bbox: Bbox, elements: OsmEl[], source: string): Promise<number> {
  const gz = packOsm(elements);
  await db.execute({
    sql: `INSERT INTO complex_walk_osm (complex_id, format_version, bbox, osm_gz, bytes, source, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET format_version = excluded.format_version, bbox = excluded.bbox,
            osm_gz = excluded.osm_gz, bytes = excluded.bytes, source = excluded.source, fetched_at = excluded.fetched_at`,
    args: [complexId, OSM_FORMAT, JSON.stringify(bbox), gz, gz.byteLength, source, new Date().toISOString()],
  });
  return gz.byteLength;
}

async function readRoutes(db: Client, complexId: string, mode: string): Promise<WalkPayload | null> {
  try {
    const r = await db.execute({
      sql: `SELECT payload_json FROM complex_walk_routes WHERE complex_id = ? AND from_key = '' AND mode = ? AND algo_version = ?`,
      args: [complexId, mode, WALK_ROUTES_VERSION],
    });
    const t = r.rows[0]?.payload_json;
    return t ? (JSON.parse(String(t)) as WalkPayload) : null;
  } catch {
    return null;
  }
}

export async function storeRoutes(db: Client, complexId: string, mode: string, payload: WalkPayload): Promise<void> {
  await db.execute({
    sql: `INSERT INTO complex_walk_routes (complex_id, from_key, mode, algo_version, payload_json, built_at)
          VALUES (?, '', ?, ?, ?, ?)
          ON CONFLICT(complex_id, from_key, mode) DO UPDATE SET algo_version = excluded.algo_version,
            payload_json = excluded.payload_json, built_at = excluded.built_at`,
    args: [complexId, mode, WALK_ROUTES_VERSION, JSON.stringify(payload), new Date().toISOString()],
  });
}

/** 경로 계산 입력 — 단지 좌표·동 모양·주변 학교·역 (DB 읽기 2번) */
export async function loadWalkInput(db: Client, complexId: string): Promise<WalkInput | null> {
  const base = await readComplex3d(db, complexId, { shapesOnly: true });
  if (!base) return null;
  const [mRows, schoolRows, railRows] = (
    await db.batch(
      [
        { sql: `SELECT sigungu FROM apt_complex_master WHERE complex_id = ?`, args: [complexId] },
        {
          sql: `SELECT s.school_name, s.school_level, s.lat, s.lng FROM complex_nearby_schools n
                JOIN school_master s ON s.school_code = n.school_code
                WHERE n.complex_id = ? AND s.lat IS NOT NULL ORDER BY n.distance_m LIMIT 12`,
          args: [complexId],
        },
        railStationsBoxStatement(base.center, 1100),
      ],
      "read",
    )
  ).map((r) => r.rows);
  const sigungu = mRows![0]?.sigungu ? String(mRows![0].sigungu).split(/\s+/).pop()! : null;
  return {
    complexId,
    center: base.center,
    sigungu,
    buildings: base.buildings.map((b) => ({ id: b.id, dong: b.dong, residential: b.residential, rings: b.rings })),
    schools: schoolRows!.map((r) => ({
      name: String(r.school_name),
      level: r.school_level == null ? null : String(r.school_level),
      lat: Number(r.lat),
      lng: Number(r.lng),
    })),
    stations: rankNearbyRailStations(railRows!, base.center, 1100, 6).map((s) => ({ name: s.name, lines: s.lines, lat: s.lat, lng: s.lng })),
  };
}

/**
 * 걷기 결과 — 저장된 기본 결과 → 저장본으로 계산 → Overpass(성공하면 저장). `write=false`면 DB에 쓰지 않는다.
 * 반환 source: 어디서 왔는지 (응답 헤더로만 쓴다)
 */
export async function getWalkPayload(
  db: Client,
  complexId: string,
  opts: { from?: string | null; mode?: "walk" | "wheel"; write?: boolean; refreshOsm?: boolean },
): Promise<{ payload: WalkPayload; source: "stored-routes" | "stored-osm" | "overpass" } | null> {
  const mode = opts.mode === "wheel" ? "wheel" : "walk";
  const write = opts.write !== false;
  if (!opts.from && !opts.refreshOsm) {
    const hit = await readRoutes(db, complexId, mode);
    if (hit) return { payload: hit, source: "stored-routes" };
  }
  const input = await loadWalkInput(db, complexId);
  if (!input) return null;
  let source: "stored-osm" | "overpass" = "stored-osm";
  const payload = await computeWalkRoutes(input, {
    from: opts.from,
    mode,
    loadOsm: async (bbox) => {
      const stored = opts.refreshOsm ? null : await readOsm(db, complexId);
      if (stored) return stored;
      source = "overpass";
      const live = await fetchOverpass(bbox);
      if (write) {
        await storeOsm(db, complexId, bbox, live.elements, live.source).catch((e) =>
          console.warn("[walk] store osm failed", e instanceof Error ? e.message : e),
        );
      }
      // 저장본과 같은 모양으로 (태그 정리) — 저장본이든 실시간이든 결과가 같게
      return unpackOsm(packOsm(live.elements));
    },
  });
  if (write && !opts.from && payload.destinations.length) {
    await storeRoutes(db, complexId, mode, payload).catch((e) =>
      console.warn("[walk] store routes failed", e instanceof Error ? e.message : e),
    );
  }
  return { payload, source };
}
