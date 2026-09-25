/**
 * Lightweight timing probe for /api/complex-nearby-schools (잠실엘스).
 * Usage: npx tsx scripts/school-materialization/probe-nearby-api-latency.ts [baseUrl]
 */
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";

async function once(url: string): Promise<{ ms: number; status: number; bytes: number; bodyStatus: string }> {
  const t0 = performance.now();
  const res = await fetch(url);
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let bodyStatus = "";
  try {
    bodyStatus = String(JSON.parse(text).status ?? "");
  } catch {
    bodyStatus = "NON_JSON";
  }
  return { ms, status: res.status, bytes: text.length, bodyStatus };
}

async function main() {
  const base = process.argv[2] || "http://127.0.0.1:3011";
  const qs = new URLSearchParams({
    aptName: "잠실엘스",
    lat: String(JAMSIL_ELS_CANONICAL_CENTER.lat),
    lng: String(JAMSIL_ELS_CANONICAL_CENTER.lng),
    complexId: JAMSIL_ELS_CANONICAL_CENTER.complexId,
  });
  const url = `${base.replace(/\/$/, "")}/api/complex-nearby-schools?${qs}`;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await once(url));
  }
  console.log(
    JSON.stringify(
      {
        url,
        cold_ms: samples[0]?.ms,
        warm_ms: samples.slice(1).map((s) => s.ms),
        samples,
        notes: [
          "cold includes NEIS live schoolInfo fetch for pilot name seeds",
          "district/attendance payloads are static seed JSON (no runtime PIP)",
          "needsClientGeocode often true when NEIS LAT/LOT missing",
        ],
      },
      null,
      2,
    ),
  );
}

main();
