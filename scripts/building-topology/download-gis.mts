import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireOfficialGis } from "@/lib/buildings/gis-acquire";
import {
  GIS_CACHE_DIR,
  GIS_DATASET_NAME,
  emptyManifest,
  localShpFiles,
  writeManifest,
} from "@/lib/buildings/gis-source";

async function main() {
  mkdirSync(GIS_CACHE_DIR, { recursive: true });
  const acquired = await acquireOfficialGis();
  const shp = localShpFiles();
  const status = shp.length
    ? "LOCAL_SHP"
    : acquired.sourceTemporarilyUnavailable
      ? "SOURCE_TEMPORARILY_UNAVAILABLE"
      : "FILE_AVAILABLE";
  const manifest = emptyManifest(
    JSON.stringify({
      successfulOfficialPath: acquired.successfulOfficialPath,
      failedPaths: acquired.failedPaths,
      wfsValidationOk: acquired.wfsValidationOk,
      fileUrl: acquired.fileUrl,
      paths: acquired.paths.map((p) => ({
        path: p.path,
        status: p.status,
        attempts: p.attempts.map((a) => ({
          attempt: a.attempt,
          url: a.url,
          http: a.http,
          error: a.error,
          contentType: a.contentType,
          looksLikeFile: a.looksLikeFile,
        })),
      })),
      localShp: shp,
      note: "WFS used only for small targeted validation; not ingested as national footprints",
    }),
    status,
  );
  manifest.successfulOfficialPath = acquired.successfulOfficialPath;
  manifest.failedPaths = acquired.failedPaths;
  manifest.fileList = shp;
  manifest.localPath = shp[0] ?? "";
  manifest.wfsFallbackUsed = false;
  const path = writeManifest(manifest);
  const copy = join(process.cwd(), "data/poc/building-topology/gis-source-manifest.json");
  writeFileSync(copy, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    dataset: GIS_DATASET_NAME,
    manifest: path,
    SOURCE_TEMPORARILY_UNAVAILABLE: acquired.sourceTemporarilyUnavailable,
    successfulOfficialPath: acquired.successfulOfficialPath,
    failedPaths: acquired.failedPaths,
    wfsValidationOk: acquired.wfsValidationOk,
    probes: acquired.probes.map((p) => ({
      path: p.path,
      attempt: p.attempt,
      url: p.url,
      http: p.http,
      error: p.error,
    })),
    shp,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
