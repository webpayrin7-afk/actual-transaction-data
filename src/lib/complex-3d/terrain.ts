/**
 * 지형(표고) — 서버 전용. 원천을 갈아 끼울 수 있게 `ElevationSource` 목록을 우선순위대로 둔다.
 *
 * 1) local-grid: 미리 변환한 고해상도 격자(국토지리정보원 수치표고모델 5m 등)가 `TERRAIN_GRID_DIR`에 있으면 먼저 쓴다.
 *    manifest.json = { id, label, license, resolutionM, tiles: [{ file, west, south, east, north, cols, rows, noData? }] }
 *    각 tile 파일은 WGS84 위경도 등간격 Float32 LE 원시 격자 (북쪽 행부터). 예) NGII DEM(.img, EPSG:5186) →
 *    `gdalwarp -t_srs EPSG:4326 -tr 0.00005 0.00005 -r bilinear -ot Float32 -of ENVI in.img out.bin` (ENVI = 원시 + .hdr).
 * 2) aws-terrarium: AWS Open Data "Terrain Tiles" (terrarium PNG). 한국은 SRTM 기반 약 30m — 시제품용 기본값.
 *
 * 격자는 단지 중심 기준 로컬 미터(x=동, z=남) — 3D 장면 좌표와 같다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodePng } from "@/lib/complex-3d/png";
import type { TerrainGridPayload } from "@/lib/complex-3d/ground";

export type Bbox = { south: number; west: number; north: number; east: number };
export type ElevationInfo = { id: string; label: string; license: string; resolutionM: number };
export type Sampler = { info: ElevationInfo; at: (lat: number, lng: number) => number };

interface ElevationSource {
  info(): Promise<ElevationInfo | null>;
  /** bbox 전체를 덮을 수 있으면 표본기, 아니면 null */
  load(bbox: Bbox): Promise<((lat: number, lng: number) => number) | null>;
}

// ── aws-terrarium ────────────────────────────────────────────────────────────
const TERRARIUM_Z = 14;
const TILE_CAP = 48;
const tileCache = new Map<string, Promise<Float32Array>>();

function lng2x(lng: number, z: number) {
  return ((lng + 180) / 360) * 2 ** z;
}
function lat2y(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function terrariumTile(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) {
    tileCache.delete(key);
    tileCache.set(key, hit);
    return hit;
  }
  const p = (async () => {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`terrarium ${res.status}`);
    const png = decodePng(new Uint8Array(await res.arrayBuffer()));
    const out = new Float32Array(png.width * png.height);
    for (let i = 0; i < out.length; i++) {
      const o = i * png.channels;
      out[i] = png.data[o]! * 256 + png.data[o + 1]! + png.data[o + 2]! / 256 - 32768;
    }
    return out;
  })();
  p.catch(() => tileCache.delete(key));
  tileCache.set(key, p);
  while (tileCache.size > TILE_CAP) tileCache.delete(tileCache.keys().next().value!);
  return p;
}

const terrarium: ElevationSource = {
  async info() {
    return {
      id: "aws-terrarium",
      label: "AWS Terrain Tiles (SRTM 기반)",
      license: "Mapzen/AWS Terrain Tiles — SRTM(퍼블릭 도메인) 등, 출처 표기 권장",
      resolutionM: 30,
    };
  },
  async load(bbox) {
    const z = TERRARIUM_Z;
    const x0 = Math.floor(lng2x(bbox.west, z));
    const x1 = Math.floor(lng2x(bbox.east, z));
    const y0 = Math.floor(lat2y(bbox.north, z));
    const y1 = Math.floor(lat2y(bbox.south, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 16) return null;
    const tiles = new Map<string, Float32Array>();
    await Promise.all(
      [...Array(x1 - x0 + 1)].flatMap((_, i) =>
        [...Array(y1 - y0 + 1)].map(async (__, j) => {
          tiles.set(`${x0 + i}/${y0 + j}`, await terrariumTile(z, x0 + i, y0 + j));
        }),
      ),
    );
    const px = (tx: number, ty: number) => {
      const t = tiles.get(`${Math.floor(tx / 256)}/${Math.floor(ty / 256)}`);
      if (!t) return 0;
      return t[(ty % 256) * 256 + (tx % 256)]!;
    };
    return (lat, lng) => {
      // 픽셀 중심 기준 쌍선형
      const fx = lng2x(lng, z) * 256 - 0.5;
      const fy = lat2y(lat, z) * 256 - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ax = fx - ix;
      const ay = fy - iy;
      return (
        px(ix, iy) * (1 - ax) * (1 - ay) + px(ix + 1, iy) * ax * (1 - ay) + px(ix, iy + 1) * (1 - ax) * ay + px(ix + 1, iy + 1) * ax * ay
      );
    };
  },
};

// ── local-grid (고해상도, 선택) ──────────────────────────────────────────────
type LocalTile = { file: string; west: number; south: number; east: number; north: number; cols: number; rows: number; noData?: number };
type LocalManifest = ElevationInfo & { tiles: LocalTile[] };
let manifestP: Promise<LocalManifest | null> | null = null;
const localFiles = new Map<string, Promise<Float32Array>>();

function localManifest(): Promise<LocalManifest | null> {
  const dir = process.env.TERRAIN_GRID_DIR?.trim();
  if (!dir) return Promise.resolve(null);
  manifestP ??= readFile(path.join(dir, "manifest.json"), "utf8")
    .then((t) => JSON.parse(t) as LocalManifest)
    .catch(() => null);
  return manifestP;
}

const localGrid: ElevationSource = {
  async info() {
    const m = await localManifest();
    return m ? { id: m.id, label: m.label, license: m.license, resolutionM: m.resolutionM } : null;
  },
  async load(bbox) {
    const m = await localManifest();
    const dir = process.env.TERRAIN_GRID_DIR?.trim();
    if (!m || !dir) return null;
    const use = m.tiles.filter((t) => t.east > bbox.west && t.west < bbox.east && t.north > bbox.south && t.south < bbox.north);
    if (!use.length) return null;
    const grids = await Promise.all(
      use.map((t) => {
        let p = localFiles.get(t.file);
        if (!p) {
          p = readFile(path.join(dir, t.file)).then((b) => new Float32Array(b.buffer, b.byteOffset, t.cols * t.rows));
          localFiles.set(t.file, p);
        }
        return p;
      }),
    );
    // 모서리 네 곳이 모두 덮이는지
    const find = (lat: number, lng: number) => use.findIndex((t) => lng >= t.west && lng <= t.east && lat >= t.south && lat <= t.north);
    if ([find(bbox.south, bbox.west), find(bbox.south, bbox.east), find(bbox.north, bbox.west), find(bbox.north, bbox.east)].some((i) => i < 0))
      return null;
    return (lat, lng) => {
      const i = find(lat, lng);
      if (i < 0) return NaN;
      const t = use[i]!;
      const g = grids[i]!;
      const fx = ((lng - t.west) / (t.east - t.west)) * t.cols - 0.5;
      const fy = ((t.north - lat) / (t.north - t.south)) * t.rows - 0.5;
      const cx = Math.max(0, Math.min(t.cols - 2, Math.floor(fx)));
      const cy = Math.max(0, Math.min(t.rows - 2, Math.floor(fy)));
      const ax = Math.max(0, Math.min(1, fx - cx));
      const ay = Math.max(0, Math.min(1, fy - cy));
      const v = (x: number, y: number) => g[y * t.cols + x]!;
      return v(cx, cy) * (1 - ax) * (1 - ay) + v(cx + 1, cy) * ax * (1 - ay) + v(cx, cy + 1) * (1 - ax) * ay + v(cx + 1, cy + 1) * ax * ay;
    };
  },
};

/** 우선순위 — 고해상도가 있으면 그것, 없으면 AWS */
const SOURCES: ElevationSource[] = [localGrid, terrarium];

/** bbox를 덮는 가장 좋은 원천의 표본기 */
export async function elevationSampler(bbox: Bbox): Promise<Sampler | null> {
  for (const s of SOURCES) {
    try {
      const at = await s.load(bbox);
      const info = await s.info();
      if (at && info) return { info, at };
    } catch (error) {
      console.warn("[terrain] source failed", error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export function bboxAround(center: { lat: number; lng: number }, halfM: number): Bbox {
  const dLat = halfM / 111_320;
  const dLng = halfM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return { south: center.lat - dLat, north: center.lat + dLat, west: center.lng - dLng, east: center.lng + dLng };
}

/** 3D 바닥용 격자 — n×n 꼭짓점, 한 변 sizeM, 단지 중심 기준 상대 높이 */
export async function terrainGrid(center: { lat: number; lng: number }, sizeM: number, n = 128): Promise<TerrainGridPayload | null> {
  const sampler = await elevationSampler(bboxAround(center, sizeM / 2 + 20));
  if (!sampler) return null;
  const mPerLng = 111_320 * Math.cos((center.lat * Math.PI) / 180);
  const origin = sampler.at(center.lat, center.lng);
  const out = new Int16Array(n * n);
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < n; r++) {
    const z = -sizeM / 2 + (sizeM * r) / (n - 1);
    const lat = center.lat - z / 111_320;
    for (let c = 0; c < n; c++) {
      const x = -sizeM / 2 + (sizeM * c) / (n - 1);
      const h = sampler.at(lat, center.lng + x / mPerLng);
      const rel = Number.isFinite(h) ? h - origin : 0;
      min = Math.min(min, rel);
      max = Math.max(max, rel);
      out[r * n + c] = Math.max(-32000, Math.min(32000, Math.round(rel * 10)));
    }
  }
  return {
    source: sampler.info.id,
    sourceLabel: sampler.info.label,
    resolutionM: sampler.info.resolutionM,
    sizeM,
    n,
    originElevationM: Math.round(origin * 10) / 10,
    minM: Math.round(min * 10) / 10,
    maxM: Math.round(max * 10) / 10,
    heights: Buffer.from(out.buffer).toString("base64"),
  };
}
