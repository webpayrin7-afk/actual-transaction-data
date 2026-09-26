/**
 * 정비사업 연결에 필요한 바깥 입력을 모은다. DB 쓰기 없음.
 *
 *   npx tsx scripts/redev/fetch-inputs.ts --out=C:/data/redev/out
 *
 * 1) 사업 위치1(지번) NAVER 지오코딩 → geocode.jsonl (scripts/map-anchor 방식: 결과가 정확히 1개일 때만 OK).
 *    질의 = "서울특별시 {자치구} {위치1}"; 위치1 끝의 '번지'·'일대'·'일원'·'외 N필지'·괄호는 뗀다(지번만 남김).
 *    이미 받은 질의는 다시 부르지 않는다(missing-only).
 * 2) 좌표 대조용: 한 필지 자율주택정비사업 구역(UQ1811, 이름 "OO동 123-4 자율주택…")의 지번을 같은 방식으로 지오코딩.
 * 3) complex_map_anchor(서울 범위 bbox) → anchors.json (complex_id, 단지명, lat, lng).
 * Env: NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET, TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const GEOCODE_URL = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";
const SEOUL_BBOX = { minLat: 37.40, maxLat: 37.72, minLng: 126.75, maxLng: 127.20 };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Geo = {
  query: string;
  status: "OK" | "AMBIGUOUS" | "NOT_FOUND" | "ERROR";
  result_count: number;
  lat: number | null;
  lng: number | null;
  matched_jibun: string | null;
  matched_road: string | null;
  error?: string;
};

async function geocode(query: string): Promise<Geo> {
  const id = process.env.NAVER_MAP_CLIENT_ID!;
  const secret = process.env.NAVER_MAP_CLIENT_SECRET!;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${GEOCODE_URL}?query=${encodeURIComponent(query)}`, {
        headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret, Accept: "application/json" },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = ((await res.json()) as { addresses?: Array<Record<string, string>> }).addresses ?? [];
      const first = list[0] ?? null;
      return {
        query,
        status: list.length === 0 ? "NOT_FOUND" : list.length > 1 ? "AMBIGUOUS" : "OK",
        result_count: list.length,
        lat: first ? Number(first.y) : null,
        lng: first ? Number(first.x) : null,
        matched_jibun: first?.jibunAddress || null,
        matched_road: first?.roadAddress || null,
      };
    }
    throw new Error("retries exhausted");
  } catch (e) {
    return { query, status: "ERROR", result_count: 0, lat: null, lng: null, matched_jibun: null, matched_road: null, error: (e as Error).message };
  }
}

/** 위치1 → 지번만: "서린동111-1번지일대" → "서린동 111-1", "여의도동37,37-1" → "여의도동 37"(처음 적힌 지번) */
function jibunQuery(gu: string, addr: string): string | null {
  const s = addr
    .replace(/^\s*서울(특별)?시\s*/, "")
    .replace(new RegExp(`^\\s*${gu}\\s*`), "")
    .replace(/\(.*?\)/g, " ")
    .replace(/\s*외\s*\d*\s*(필지)?.*$/, "")
    .replace(/,.*$/, "")
    .replace(/(번지)?\s*(일대|일원)\s*$/, "")
    .replace(/번지\s*$/, "")
    .trim();
  const m = s.match(/^(.+?[^\d\s-])\s*(산\s*)?(\d+(?:-\d+)?)$/);
  if (!m) return null;
  return `서울특별시 ${gu} ${m[1]!.trim()} ${m[2] ? "산" : ""}${m[3]}`;
}

async function main() {
  const out = arg("out");
  if (!out) throw new Error("--out=<dir> 이 필요합니다.");
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");

  const cacheFile = join(out, "geocode.jsonl");
  const cache = new Map<string, Geo>();
  if (existsSync(cacheFile)) {
    for (const line of readFileSync(cacheFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const g = JSON.parse(line) as Geo;
      if (g.status !== "ERROR") cache.set(g.query, g);
    }
  }

  const projects = JSON.parse(readFileSync(join(out, "projects.json"), "utf8")) as Array<Record<string, string | null>>;
  const queries = new Set<string>();
  let noQuery = 0;
  for (const p of projects) {
    const q = p.addr_jibun ? jibunQuery(p.gu!, p.addr_jibun) : null;
    if (q) queries.add(q);
    else noQuery++;
  }
  const zones = readFileSync(join(out, "zones.ndjson"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  for (const z of zones) {
    if (z.category_code !== "UQ1811" || !z.gu) continue;
    const m = String(z.name).match(/^(\S+[동가로])\s+(\d+(?:-\d+)?)\s*(번지)?\s*자율주택/);
    if (m) queries.add(`서울특별시 ${z.gu} ${m[1]} ${m[2]}`);
  }

  const todo = [...queries].filter((q) => !cache.has(q));
  console.log(JSON.stringify({ projects: projects.length, project_without_jibun_query: noQuery, queries: queries.size, cached: queries.size - todo.length, to_fetch: todo.length }));
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const q = todo[next++]!;
      const g = await geocode(q);
      cache.set(q, g);
      appendFileSync(cacheFile, JSON.stringify(g) + "\n");
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const counts: Record<string, number> = {};
  for (const q of queries) counts[cache.get(q)!.status] = (counts[cache.get(q)!.status] ?? 0) + 1;
  console.log(JSON.stringify({ geocode: counts }));

  const anchors = (
    await db.execute({
      sql: `SELECT a.complex_id, m.apt_name, a.lat, a.lng
            FROM complex_map_anchor a JOIN apt_complex_master m ON m.complex_id = a.complex_id
            WHERE a.lat BETWEEN ? AND ? AND a.lng BETWEEN ? AND ?
            ORDER BY a.complex_id`,
      args: [SEOUL_BBOX.minLat, SEOUL_BBOX.maxLat, SEOUL_BBOX.minLng, SEOUL_BBOX.maxLng],
    })
  ).rows.map((r) => ({ complex_id: String(r.complex_id), apt_name: String(r.apt_name), lat: Number(r.lat), lng: Number(r.lng) }));
  writeFileSync(join(out, "anchors.json"), JSON.stringify(anchors));
  console.log(JSON.stringify({ anchors: anchors.length }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
