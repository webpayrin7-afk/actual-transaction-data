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
  downloadTimestamp: string;
  checksum: string;
  crs: string;
  geometryType: string;
  featureCount: number | null;
  validGeometryCount: number | null;
  licenseAttribution: string;
  wfsFallbackUsed: boolean;
  acquisitionStatus: string;
  successfulOfficialPath: string;
  failedPaths: string[];
  fileList: string[];
  compressedSize: number | null;
  extractedSize: number | null;
  localPath: string;
  detail: string;
  createdAt: string;
};

export const GIS_DATASET_NAME = "국토교통부_GIS건물통합정보";
export const GIS_LICENSE =
  "공공누리 제1유형(출처표시). 국토교통부 GIS건물통합정보 / data.go.kr 15083092 / VWorld dsId=18";

const CANDIDATE_URLS = [
  "https://www.data.go.kr/data/15083092/fileData.do",
  "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=18",
  "https://data.nsdi.go.kr",
];

export function emptyManifest(detail: string, status = "SOURCE_TEMPORARILY_UNAVAILABLE"): GisSourceManifest {
  const createdAt = new Date().toISOString();
  return {
    sourceDataset: GIS_DATASET_NAME,
    sourceVersion: "20260809",
    sourceDate: "2026-08-09",
    downloadTimestamp: createdAt,
    checksum: "",
    crs: "",
    geometryType: "",
    featureCount: 6656497,
    validGeometryCount: null,
    licenseAttribution: GIS_LICENSE,
    wfsFallbackUsed: false,
    acquisitionStatus: status,
    successfulOfficialPath: "",
    failedPaths: [],
    fileList: [],
    compressedSize: null,
    extractedSize: null,
    localPath: "",
    detail,
    createdAt,
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
