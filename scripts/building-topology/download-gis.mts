import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANDIDATE_URLS,
  GIS_CACHE_DIR,
  GIS_DATASET_NAME,
  emptyManifest,
  localShpFiles,
  writeManifest,
} from "@/lib/buildings/gis-source";

async function probe(url: string): Promise<{ url: string; http: number; error: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const res = await fetch(url, {
      headers: { "User-Agent": "ziplab-building-topology" },
      signal: ac.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    return { url, http: res.status, error: "" };
  } catch (error) {
    return { url, http: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  mkdirSync(GIS_CACHE_DIR, { recursive: true });
  const probes = [];
  for (const url of CANDIDATE_URLS) {
    probes.push(await probe(url));
  }
  const shp = localShpFiles();
  const usable = probes.filter((p) => p.http === 200);
  const manifest = emptyManifest(
    JSON.stringify({ probes, localShp: shp, note: "WFS fallback not used" }),
    shp.length ? "LOCAL_SHP" : usable.length ? "PAGE_ONLY_NO_FILE" : "SOURCE_UNAVAILABLE",
  );
  manifest.localPath = shp[0] ?? "";
  manifest.wfsFallbackUsed = false;
  const path = writeManifest(manifest);
  const copy = join(process.cwd(), "data/poc/building-topology/gis-source-manifest.json");
  writeFileSync(copy, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ dataset: GIS_DATASET_NAME, manifest: path, probes, shp }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
