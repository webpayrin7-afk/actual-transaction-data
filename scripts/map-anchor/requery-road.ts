/**
 * complex_map_anchor 보정 — 지번으로 받은 앵커를 도로명 주소로 다시 받는다.
 * NAVER 지도의 아파트 이름표(POI)는 도로명 주소 지점에 있고, 지번 지오코딩은 필지 대표점이라
 * 대단지에서 수백 m 어긋난다 (예: 잠실엘스 지번점 37.51412,127.07934 ↔ 도로명점 37.51331,127.08160).
 *
 *   npx tsx scripts/map-anchor/requery-road.ts                    # dry-run: JSONL + 요약, DB 쓰기 없음
 *   npx tsx scripts/map-anchor/requery-road.ts --lawd=11710       # 시군구 하나만
 *   npx tsx scripts/map-anchor/requery-road.ts --apply --from=data/map-anchor/requery-<run>.jsonl
 *
 * 규칙: dry-run → 건수 확인 → apply → 같은 범위 재실행 시 후보 0.
 * - 대상: query_kind='jibun' 이고 matched_road(지번 지오코딩이 돌려준 도로명)가 있는 앵커만.
 * - 질의: matched_road 그대로. 결과가 정확히 1건이고 그 도로명이 matched_road와 같을 때만 OK.
 * - 기존 앵커에서 MAX_SHIFT_M 넘게 움직이면 FAR (적용 안 함).
 * - UPDATE는 query_kind='jibun' 조건을 걸어 한 번만 적용된다.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

const GEOCODE_URL = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";
const MAX_SHIFT_M = 800;
const OUT_DIR = "data/map-anchor";

type Status = "OK" | "MISMATCH" | "AMBIGUOUS" | "NOT_FOUND" | "FAR" | "ERROR";
type Row = {
  complex_id: string;
  query: string;
  status: Status;
  lat: number | null;
  lng: number | null;
  matched_road: string | null;
  matched_jibun: string | null;
  shift_m: number | null;
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

async function geocode(query: string): Promise<Array<Record<string, string>>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${GEOCODE_URL}?query=${encodeURIComponent(query)}`, {
      headers: {
        "X-NCP-APIGW-API-KEY-ID": process.env.NAVER_MAP_CLIENT_ID!,
        "X-NCP-APIGW-API-KEY": process.env.NAVER_MAP_CLIENT_SECRET!,
        Accept: "application/json",
      },
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { addresses?: Array<Record<string, string>> };
    return body.addresses ?? [];
  }
  throw new Error("retries exhausted");
}

function db(): Client {
  return createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function dryRun() {
  const lawd = arg("lawd");
  const limit = Number(arg("limit") ?? 0) || null;
  const concurrency = Math.max(1, Math.min(10, Number(arg("concurrency") ?? 6)));
  const client = db();
  const rows = (
    await client.execute({
      sql: `SELECT a.complex_id, a.lat, a.lng, a.matched_road
            FROM complex_map_anchor a
            ${lawd ? "JOIN apt_complex_master m ON m.complex_id = a.complex_id" : ""}
            WHERE a.query_kind = 'jibun' AND a.matched_road IS NOT NULL AND a.matched_road <> ''
            ${lawd ? "AND m.lawd_cd = ?" : ""}
            ORDER BY a.complex_id
            ${limit ? `LIMIT ${limit}` : ""}`,
      args: lawd ? [lawd] : [],
    })
  ).rows;

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(OUT_DIR, `requery-${lawd ?? "all"}-${stamp}.jsonl`);
  writeFileSync(file, "");
  console.log(`dry-run: ${rows.length} jibun anchors with a road address → ${file}`);

  const counts: Record<Status, number> = { OK: 0, MISMATCH: 0, AMBIGUOUS: 0, NOT_FOUND: 0, FAR: 0, ERROR: 0 };
  const shifts: number[] = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < rows.length) {
      const r = rows[next++]!;
      const query = String(r.matched_road);
      let out: Row;
      try {
        const list = await geocode(query);
        const first = list[0] ?? null;
        const lat = first ? Number(first.y) : null;
        const lng = first ? Number(first.x) : null;
        const shift = lat != null && lng != null ? Math.round(haversineM(Number(r.lat), Number(r.lng), lat, lng)) : null;
        const status: Status =
          list.length === 0
            ? "NOT_FOUND"
            : list.length > 1
              ? "AMBIGUOUS"
              : first!.roadAddress !== query
                ? "MISMATCH"
                : shift != null && shift > MAX_SHIFT_M
                  ? "FAR"
                  : "OK";
        out = {
          complex_id: String(r.complex_id),
          query,
          status,
          lat,
          lng,
          matched_road: first?.roadAddress || null,
          matched_jibun: first?.jibunAddress || null,
          shift_m: shift,
        };
        if (status === "OK" && shift != null) shifts.push(shift);
      } catch (e) {
        out = {
          complex_id: String(r.complex_id), query, status: "ERROR", lat: null, lng: null,
          matched_road: null, matched_jibun: null, shift_m: null, error: (e as Error).message,
        };
      }
      counts[out.status]++;
      appendFileSync(file, JSON.stringify(out) + "\n");
      if (++done % 1000 === 0) console.log(`  ${done}/${rows.length}`, JSON.stringify(counts));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  shifts.sort((a, b) => a - b);
  const q = (p: number) => (shifts.length ? shifts[Math.min(shifts.length - 1, Math.floor(p * shifts.length))] : null);
  const summary = {
    file,
    candidates: rows.length,
    counts,
    would_update: counts.OK,
    shift_m: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: shifts.at(-1) ?? null },
  };
  writeFileSync(file.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

async function apply() {
  const from = arg("from");
  if (!from || !existsSync(from)) throw new Error("--apply needs --from=<requery .jsonl>");
  const client = db();
  const rows: Row[] = [];
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line) as Row);
  const ok = rows.filter((r) => r.status === "OK" && r.lat != null && r.lng != null);
  const now = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < ok.length; i += 200) {
    const batch = ok.slice(i, i + 200).map((r) => ({
      sql: `UPDATE complex_map_anchor
            SET lat = ?, lng = ?, query_kind = 'road', query = ?, matched_road = ?, matched_jibun = ?, geocoded_at = ?
            WHERE complex_id = ? AND query_kind = 'jibun'`,
      args: [r.lat, r.lng, r.query, r.matched_road, r.matched_jibun, now, r.complex_id],
    }));
    const res = await client.batch(batch, "write");
    updated += res.reduce((s, x) => s + x.rowsAffected, 0);
  }
  console.log(JSON.stringify({ from, ok_in_file: ok.length, updated }, null, 2));
}

loadEnv();
if (!process.env.NAVER_MAP_CLIENT_ID || !process.env.NAVER_MAP_CLIENT_SECRET) throw new Error("NAVER_MAP_CLIENT_ID/SECRET missing");
if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL missing");
(arg("apply") ? apply() : dryRun()).catch((e) => {
  console.error(e);
  process.exit(1);
});
