/**
 * NAVER map anchor per complex — the point NAVER Maps uses for the complex address,
 * so map markers sit on the NAVER apartment label instead of the parcel representative point.
 *
 *   npx tsx scripts/map-anchor/geocode-anchors.ts                 # dry-run (default): geocode → JSONL + summary, NO DB write
 *   npx tsx scripts/map-anchor/geocode-anchors.ts --limit=200     # dry-run on a sample
 *   npx tsx scripts/map-anchor/geocode-anchors.ts --apply --from=data/map-anchor/<run>.jsonl
 *                                                                  # insert reviewed OK rows (missing-only, INSERT OR IGNORE)
 *
 * Rules (ZIPLAB_STATUS): dry-run → count → apply → re-run apply = 0 inserted.
 * - Query: road_address, else "sido sigungu legal_dong_name jibun". Never the complex name (no fuzzy match).
 * - Accept only exactly one geocode result; if a parcel point exists, the anchor must be within FAR_M of it.
 * - New table complex_map_anchor only; apt_complex_master coordinates are not modified.
 * Env: NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET (NCP Maps, Geocoding enabled), TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

const GEOCODE_URL = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";
const FAR_M = 1000;
const OUT_DIR = "data/map-anchor";

type Status = "OK" | "AMBIGUOUS" | "NOT_FOUND" | "FAR" | "ERROR";
type Result = {
  complex_id: string;
  apt_name: string;
  query_kind: "road" | "jibun";
  query: string;
  status: Status;
  result_count: number;
  lat: number | null;
  lng: number | null;
  matched_road: string | null;
  matched_jibun: string | null;
  parcel_distance_m: number | null;
  error?: string;
};

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
    }
  }
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function geocode(query: string): Promise<{ count: number; first: Record<string, string> | null }> {
  const id = process.env.NAVER_MAP_CLIENT_ID!;
  const secret = process.env.NAVER_MAP_CLIENT_SECRET!;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${GEOCODE_URL}?query=${encodeURIComponent(query)}`, {
      headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret, Accept: "application/json" },
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { addresses?: Array<Record<string, string>> };
    const list = body.addresses ?? [];
    return { count: list.length, first: list[0] ?? null };
  }
  throw new Error("retries exhausted");
}

function db(): Client {
  return createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function tableExists(client: Client): Promise<boolean> {
  const r = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name='complex_map_anchor'",
    args: [],
  });
  return r.rows.length > 0;
}

async function dryRun() {
  const limit = Number(arg("limit") ?? 0) || null;
  const concurrency = Math.max(1, Math.min(10, Number(arg("concurrency") ?? 6)));
  const client = db();
  const haveTable = await tableExists(client);
  const rows = (
    await client.execute({
      sql: `SELECT m.complex_id, m.apt_name, m.road_address, m.sido, m.sigungu, m.legal_dong_name, m.jibun,
                   m.latitude, m.longitude
            FROM apt_complex_master m
            ${haveTable ? "LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id WHERE a.complex_id IS NULL" : ""}
            ORDER BY m.complex_id
            ${limit ? `LIMIT ${limit}` : ""}`,
      args: [],
    })
  ).rows;

  const candidates = rows
    .map((r) => {
      const road = r.road_address ? String(r.road_address).trim() : "";
      const parts = [r.sido, r.sigungu, r.legal_dong_name, r.jibun].map((p) => (p == null ? "" : String(p).trim()));
      const jibun = parts.every(Boolean) ? parts.join(" ") : "";
      if (!road && !jibun) return null;
      return {
        complex_id: String(r.complex_id),
        apt_name: String(r.apt_name),
        query_kind: (road ? "road" : "jibun") as "road" | "jibun",
        query: road || jibun,
        parcel: r.latitude != null && r.longitude != null ? { lat: Number(r.latitude), lng: Number(r.longitude) } : null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(OUT_DIR, `dry-run-${stamp}.jsonl`);
  writeFileSync(file, "");
  console.log(`dry-run: ${rows.length} missing anchors, ${candidates.length} with an address → ${file}`);

  const counts: Record<Status, number> = { OK: 0, AMBIGUOUS: 0, NOT_FOUND: 0, FAR: 0, ERROR: 0 };
  const dists: number[] = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < candidates.length) {
      const c = candidates[next++]!;
      let out: Result;
      try {
        const g = await geocode(c.query);
        const lat = g.first ? Number(g.first.y) : null;
        const lng = g.first ? Number(g.first.x) : null;
        const d = c.parcel && lat != null && lng != null ? Math.round(haversineM(c.parcel.lat, c.parcel.lng, lat, lng)) : null;
        const status: Status =
          g.count === 0 ? "NOT_FOUND" : g.count > 1 ? "AMBIGUOUS" : d != null && d > FAR_M ? "FAR" : "OK";
        out = {
          complex_id: c.complex_id,
          apt_name: c.apt_name,
          query_kind: c.query_kind,
          query: c.query,
          status,
          result_count: g.count,
          lat,
          lng,
          matched_road: g.first?.roadAddress || null,
          matched_jibun: g.first?.jibunAddress || null,
          parcel_distance_m: d,
        };
        if (status === "OK" && d != null) dists.push(d);
      } catch (e) {
        out = {
          complex_id: c.complex_id, apt_name: c.apt_name, query_kind: c.query_kind, query: c.query,
          status: "ERROR", result_count: 0, lat: null, lng: null, matched_road: null, matched_jibun: null,
          parcel_distance_m: null, error: (e as Error).message,
        };
      }
      counts[out.status]++;
      appendFileSync(file, JSON.stringify(out) + "\n");
      if (++done % 1000 === 0) console.log(`  ${done}/${candidates.length}`, JSON.stringify(counts));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  dists.sort((a, b) => a - b);
  const q = (p: number) => (dists.length ? dists[Math.min(dists.length - 1, Math.floor(p * dists.length))] : null);
  const summary = {
    file,
    missing: rows.length,
    with_address: candidates.length,
    counts,
    would_insert: counts.OK,
    parcel_distance_m: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: dists.at(-1) ?? null },
  };
  writeFileSync(file.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

async function apply() {
  const from = arg("from");
  if (!from || !existsSync(from)) throw new Error("--apply needs --from=<dry-run .jsonl>");
  const client = db();
  await client.execute({
    sql: `CREATE TABLE IF NOT EXISTS complex_map_anchor (
            complex_id TEXT PRIMARY KEY,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            source TEXT NOT NULL,
            query_kind TEXT NOT NULL,
            query TEXT NOT NULL,
            matched_road TEXT,
            matched_jibun TEXT,
            parcel_distance_m REAL,
            geocoded_at TEXT NOT NULL
          )`,
    args: [],
  });
  const rows: Result[] = [];
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line) as Result);
  const ok = rows.filter((r) => r.status === "OK" && r.lat != null && r.lng != null);
  const now = new Date().toISOString();
  let inserted = 0;
  for (let i = 0; i < ok.length; i += 200) {
    const batch = ok.slice(i, i + 200).map((r) => ({
      sql: `INSERT OR IGNORE INTO complex_map_anchor
              (complex_id, lat, lng, source, query_kind, query, matched_road, matched_jibun, parcel_distance_m, geocoded_at)
            VALUES (?, ?, ?, 'NAVER_GEOCODE', ?, ?, ?, ?, ?, ?)`,
      args: [r.complex_id, r.lat, r.lng, r.query_kind, r.query, r.matched_road, r.matched_jibun, r.parcel_distance_m, now],
    }));
    const res = await client.batch(batch, "write");
    inserted += res.reduce((s, x) => s + x.rowsAffected, 0);
  }
  const total = (await client.execute({ sql: "SELECT count(*) AS n FROM complex_map_anchor", args: [] })).rows[0]!.n;
  console.log(JSON.stringify({ from, ok_in_file: ok.length, inserted, table_rows: Number(total) }, null, 2));
}

loadEnv();
if (!process.env.NAVER_MAP_CLIENT_ID || !process.env.NAVER_MAP_CLIENT_SECRET) throw new Error("NAVER_MAP_CLIENT_ID/SECRET missing");
if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL missing");
(arg("apply") ? apply() : dryRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
