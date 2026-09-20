/**
 * Bounded official GIS acquisition.
 * Paths A data.go.kr / B VWorld / C NSDI / D small WFS validation.
 * Max 3 attempts per distinct path. Never loop a failing endpoint.
 */

export const GIS_MAX_ATTEMPTS_PER_PATH = 3;
export const GIS_PROBE_TIMEOUT_MS = 12_000;

export type GisPathId = "A_DATAGOKR" | "B_VWORLD" | "C_NSDI" | "D_WFS_VALIDATION";

export type GisProbe = {
  path: GisPathId;
  attempt: number;
  url: string;
  http: number;
  error: string;
  contentType: string;
  contentLength: string;
  looksLikeFile: boolean;
  looksLikePage: boolean;
  snippet: string;
};

export type GisPathResult = {
  path: GisPathId;
  attempts: GisProbe[];
  acquired: boolean;
  status: "FILE_AVAILABLE" | "PAGE_ONLY" | "WFS_VALIDATION_OK" | "SOURCE_TEMPORARILY_UNAVAILABLE";
};

const PATHS: Record<GisPathId, string[]> = {
  A_DATAGOKR: [
    "https://www.data.go.kr/data/15083092/fileData.do",
    "https://www.data.go.kr/data/15052097/fileData.do",
    "https://www.data.go.kr/tcs/dss/selectFileDataDetailView.do?publicDataPk=15083092",
  ],
  B_VWORLD: [
    "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=18",
    "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30524",
    "https://cdn.vworld.kr/download/gisBuilding",
  ],
  C_NSDI: [
    "https://data.nsdi.go.kr",
    "https://www.nsdi.go.kr",
    "https://openapi.nsdi.go.kr",
  ],
  D_WFS_VALIDATION: [
    "https://apis.data.go.kr/1611000/nsdi/BuildingService/wfs/getBuildingWFS?service=WFS&version=1.1.0&request=GetCapabilities",
    "https://openapi.nsdi.go.kr/nsdi/BuildingService/wfs/getBuildingWFS?service=WFS&version=1.1.0&request=GetCapabilities",
    "https://api.vworld.kr/ned/wfs/getBuildingWFS?service=WFS&version=1.1.0&request=GetCapabilities",
  ],
};

function looksLikeFile(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase();
  if (/zip|shapefile|octet-stream|7z|x-gzip|geopackage/.test(ct)) return true;
  return /\.(zip|7z|shp|gpkg|tar|gz)(\?|$)/i.test(url);
}

function looksLikePage(contentType: string, snippet: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  return /<!doctype html|<html/i.test(snippet);
}

function looksLikeWfs(snippet: string, contentType: string): boolean {
  const blob = `${contentType}\n${snippet}`.toLowerCase();
  return (
    blob.includes("wfs") ||
    blob.includes("wfs_capabilities") ||
    blob.includes("featuretyp") ||
    blob.includes("gml:feature") ||
    blob.includes("getcapabilities")
  ) && !blob.includes("no_openapi_service_error") && !blob.includes("servicekey is not registered");
}

export async function probeUrl(url: string): Promise<Omit<GisProbe, "path" | "attempt">> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GIS_PROBE_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": "ziplab-building-topology/gis-acquire" },
      signal: ac.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = res.headers.get("content-length") ?? "";
    const buf = new Uint8Array(await res.arrayBuffer());
    const take = buf.subarray(0, 240);
    const snippet = Buffer.from(take).toString("utf8").replace(/\s+/g, " ").slice(0, 180);
    return {
      url,
      http: res.status,
      error: "",
      contentType,
      contentLength,
      looksLikeFile: res.ok && looksLikeFile(contentType, url),
      looksLikePage: looksLikePage(contentType, snippet),
      snippet,
    };
  } catch (error) {
    return {
      url,
      http: 0,
      error: error instanceof Error ? error.message : String(error),
      contentType: "",
      contentLength: "",
      looksLikeFile: false,
      looksLikePage: false,
      snippet: "",
    };
  }
}

export async function acquireOfficialGis(): Promise<{
  paths: GisPathResult[];
  successfulOfficialPath: string;
  failedPaths: GisPathId[];
  sourceTemporarilyUnavailable: boolean;
  wfsValidationOk: boolean;
  fileUrl: string;
  probes: GisProbe[];
}> {
  const paths: GisPathResult[] = [];
  const probes: GisProbe[] = [];
  for (const path of Object.keys(PATHS) as GisPathId[]) {
    const urls = PATHS[path].slice(0, GIS_MAX_ATTEMPTS_PER_PATH);
    const attempts: GisProbe[] = [];
    for (let i = 0; i < urls.length; i += 1) {
      const raw = await probeUrl(urls[i]);
      const probe: GisProbe = { path, attempt: i + 1, ...raw };
      attempts.push(probe);
      probes.push(probe);
    }
    const fileHit = attempts.find((a) => a.looksLikeFile && a.http === 200);
    const wfsOk =
      path === "D_WFS_VALIDATION" &&
      attempts.some((a) => a.http === 200 && looksLikeWfs(a.snippet, a.contentType));
    const pageOnly = attempts.some((a) => a.http === 200 && a.looksLikePage);
    let status: GisPathResult["status"] = "SOURCE_TEMPORARILY_UNAVAILABLE";
    if (fileHit) status = "FILE_AVAILABLE";
    else if (wfsOk) status = "WFS_VALIDATION_OK";
    else if (pageOnly && path !== "D_WFS_VALIDATION") status = "PAGE_ONLY";
    paths.push({
      path,
      attempts,
      acquired: status === "FILE_AVAILABLE",
      status,
    });
  }
  const filePath = paths.find((p) => p.status === "FILE_AVAILABLE");
  const failedPaths = paths
    .filter((p) => p.status === "SOURCE_TEMPORARILY_UNAVAILABLE" || p.status === "PAGE_ONLY")
    .map((p) => p.path);
  const wfsValidationOk = paths.some((p) => p.status === "WFS_VALIDATION_OK");
  const bulkFileOk = Boolean(filePath);
  return {
    paths,
    successfulOfficialPath: filePath?.path ?? "",
    failedPaths,
    sourceTemporarilyUnavailable: !bulkFileOk,
    wfsValidationOk,
    fileUrl: filePath?.attempts.find((a) => a.looksLikeFile)?.url ?? "",
    probes,
  };
}
