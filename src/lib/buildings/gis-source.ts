import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GIS_CACHE_DIR = join(process.cwd(), "data/cache/gis-building");
export const GIS_MANIFEST_PATH = join(
  process.cwd(),
  "data/poc/building-topology/gis-source-manifest.json",
);

export type GisSourceManifest = {
  sourceDataset: string;
  sourceVersion: string;
  sourceDate: string;
  checksum: string;
  crs: string;
  featureCount: number | null;
  validGeometryCount: number | null;
  licenseAttribution: string;
  wfsFallbackUsed: boolean;
  acquisitionStatus: string;
  localPath: string;
  detail: string;
  createdAt: string;
};

export const GIS_DATASET_NAME = "국토교통부_GIS건물통합정보";
export const GIS_LICENSE =
  "공공누리 제1유형(출처표시). 국토교통부 GIS건물통합정보 / data.go.kr 15083092 / VWorld dsId=18";

const CANDIDATE_URLS = [
  "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=18",
  "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30524",
  "https://www.data.go.kr/data/15083092/fileData.do",
];

export function emptyManifest(detail: string, status = "SOURCE_UNAVAILABLE"): GisSourceManifest {
  return {
    sourceDataset: GIS_DATASET_NAME,
    sourceVersion: "20260809",
    sourceDate: "2026-08-09",
    checksum: "",
    crs: "",
    featureCount: 6656497,
    validGeometryCount: null,
    licenseAttribution: GIS_LICENSE,
    wfsFallbackUsed: false,
    acquisitionStatus: status,
    localPath: "",
    detail,
    createdAt: new Date().toISOString(),
  };
}

export function fileChecksum(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

export function writeManifest(manifest: GisSourceManifest): string {
  mkdirSync(join(process.cwd(), "data/poc/building-topology"), { recursive: true });
  writeFileSync(GIS_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return GIS_MANIFEST_PATH;
}

export function readManifest(): GisSourceManifest | null {
  if (!existsSync(GIS_MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(GIS_MANIFEST_PATH, "utf8")) as GisSourceManifest;
  } catch {
    return null;
  }
}

export function localShpFiles(): string[] {
  if (!existsSync(GIS_CACHE_DIR)) return [];
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(GIS_CACHE_DIR)
    .filter((name) => name.toLowerCase().endsWith(".shp"))
    .map((name) => join(GIS_CACHE_DIR, name));
}

export { CANDIDATE_URLS };
