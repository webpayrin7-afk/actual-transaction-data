/**
 * Exact K-apt links for complexes that have none.
 * Match: 10-digit 법정동 + 본번/부번, or road address equality.
 * More than one candidate → no link. Existing KAPT rows are not updated.
 *
 *   ./node_modules/.bin/tsx scripts/profile-fill/link-kapt.mts <list|address|plan|apply>
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { createClient, type Client } from "@libsql/client";
import { cadastralToRegistryPnu } from "./rules";
import { jibunToken, keyFromParts, keyFromPnu, masterJibun, normalizeAddress, parcelKeyString, type ParcelKey } from "./kapt-match";

config({ path: ".env.local", quiet: true });

const OUT = "data/poc/profile";
const LIST = "data/profile-fill-cache/kapt-list.jsonl";
const KAPT_DIR = "data/profile-fill-cache/kapt";
const SIDO = ["11", "26", "27", "28", "29", "30", "31", "36", "41", "42", "43", "44", "45", "46", "47", "48", "50", "51", "52"];

class QuotaError extends Error {}
let spacingMs = 250;
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + spacingMs;
  if (wait) await sleep(wait);
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

async function fetchJson(path: string, qs: Record<string, string>): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const u = new URL(`https://apis.data.go.kr/1613000${path}`);
  u.searchParams.set("serviceKey", key);
  for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  u.searchParams.set("_type", "json");
  let last = "unknown";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pace();
    const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    if (/PER_SECOND|초당 서비스 요청제한/.test(text)) {
      spacingMs = Math.min(3000, Math.round(spacingMs * 1.8));
      last = "per-second";
    } else if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|SERVICE_REQUESTS_EXCEEDS/.test(text) && !/PER_SECOND/.test(text)) {
      throw new QuotaError("QUOTA");
    } else if (!res.ok) last = `HTTP ${res.status}`;
    else {
      const parsed = JSON.parse(text) as { response?: { header?: { resultCode?: string }; body?: { totalCount?: unknown; items?: { item?: unknown } | unknown[] } } };
      const code = String(parsed.response?.header?.resultCode ?? "");
      if (code === "00" || code === "03") {
        const body = parsed.response?.body;
        const rawItems = body?.items;
        const raw = rawItems && !Array.isArray(rawItems) ? (rawItems as { item?: unknown }).item : rawItems;
        const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
        return { total: Number(body?.totalCount ?? items.length) || 0, items };
      }
      last = code ? `API ${code}` : "bad";
    }
    await sleep(700 * (attempt + 1));
  }
  throw new Error(last);
}

function db(): Client {
  return createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
}

async function listPhase() {
  mkdirSync("data/profile-fill-cache", { recursive: true });
  const seen = new Set<string>();
  if (existsSync(LIST)) {
    for (const line of readFileSync(LIST, "utf8").split("\n")) {
      if (!line) continue;
      seen.add(String(JSON.parse(line).kaptCode));
    }
  }
  const out = createWriteStream(LIST, { flags: "a" });
  let added = 0;
  try {
    for (const sido of SIDO) {
      let page = 1;
      let total = Infinity;
      while ((page - 1) * 1000 < total) {
        const got = await fetchJson("/AptListService4/getSidoAptList4", { sidoCode: sido, pageNo: String(page), numOfRows: "1000" });
        total = got.total;
        if (got.items.length === 0) break;
        for (const item of got.items) {
          const code = str(item.kaptCode);
          if (!code || seen.has(code)) continue;
          seen.add(code);
          out.write(JSON.stringify({ kaptCode: code, bjdCode: str(item.bjdCode) }) + "\n");
          added += 1;
        }
        page += 1;
        if (page > 40) break;
      }
      console.log(JSON.stringify({ sido, total, added }));
    }
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
    console.log(JSON.stringify({ quotaStop: true, added }));
    return;
  } finally {
    out.end();
  }
  console.log(JSON.stringify({ list: seen.size, added }));
}

type Listed = { kaptCode: string; bjdCode: string };

function readList(): Listed[] {
  if (!existsSync(LIST)) return [];
  return readFileSync(LIST, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Listed);
}

async function addressPhase() {
  const linked = new Set<string>();
  const client = db();
  for (const row of (await client.execute(`SELECT source_key FROM apt_complex_source_links WHERE source = 'KAPT'`)).rows) linked.add(str(row.source_key));
  mkdirSync(KAPT_DIR, { recursive: true });
  let calls = 0;
  let skipped = 0;
  try {
    for (const row of readList()) {
      if (linked.has(row.kaptCode)) {
        skipped += 1;
        continue;
      }
      const file = `${KAPT_DIR}/${row.kaptCode}.json`;
      if (existsSync(file)) {
        const prev = JSON.parse(readFileSync(file, "utf8")) as { bassOk?: boolean };
        if (prev.bassOk) continue;
      }
      const got = await fetchJson("/AptBasisInfoServiceV5/getAphusBassInfoV5", { kaptCode: row.kaptCode });
      calls += 1;
      const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
      writeFileSync(file, JSON.stringify({ ...prev, bass: got.items[0] ?? null, bassOk: true, dtl: prev.dtl ?? null, dtlOk: Boolean(prev.dtlOk) }));
      if (calls % 200 === 0) console.log(JSON.stringify({ calls, skipped }));
    }
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
    console.log(JSON.stringify({ quotaStop: true, calls }));
    return;
  }
  console.log(JSON.stringify({ calls, skipped, quotaStop: false }));
}

function kaptParcel(bjdCode: string, addr: string): string {
  const token = jibunToken(addr);
  if (!token || !/^\d{10}$/.test(bjdCode)) return "";
  const key = keyFromParts(bjdCode, token.san, token.bun, token.ji);
  return key ? parcelKeyString(key) : "";
}

async function planPhase(apply: boolean) {
  const client = db();
  const existing = new Map<string, string>();
  for (const row of (await client.execute(`SELECT source_key, complex_id FROM apt_complex_source_links WHERE source = 'KAPT'`)).rows) {
    existing.set(str(row.source_key), str(row.complex_id));
  }
  const byParcel = new Map<string, string[]>();
  const byRoad = new Map<string, string[]>();
  let addressed = 0;
  for (const row of readList()) {
    if (existing.has(row.kaptCode)) continue;
    const file = `${KAPT_DIR}/${row.kaptCode}.json`;
    if (!existsSync(file)) continue;
    const bass = (JSON.parse(readFileSync(file, "utf8")) as { bass?: Record<string, unknown>; bassOk?: boolean }).bass;
    if (!bass) continue;
    addressed += 1;
    const bjd = str(bass.bjdCode) || row.bjdCode;
    const parcel = kaptParcel(bjd, str(bass.kaptAddr));
    if (parcel) {
      const list = byParcel.get(parcel) ?? [];
      list.push(row.kaptCode);
      byParcel.set(parcel, list);
    }
    const road = normalizeAddress(str(bass.doroJuso));
    if (road) {
      const list = byRoad.get(road) ?? [];
      list.push(row.kaptCode);
      byRoad.set(road, list);
    }
  }

  const masters = await client.execute(`SELECT complex_id, lawd_cd, bjdong_cd, jibun, road_address FROM apt_complex_master`);
  const have = new Set(existing.values());
  const cache = new Map<string, Set<string>>();
  for (const row of (await client.execute(`SELECT complex_id, pnu FROM official_unit_area_cache WHERE pnu <> ''`)).rows) {
    const set = cache.get(str(row.complex_id)) ?? new Set<string>();
    set.add(str(row.pnu));
    cache.set(str(row.complex_id), set);
  }
  const cpc = new Map<string, string>();
  for (const row of (await client.execute(`SELECT complex_id, pnu FROM complex_parcel_coordinates WHERE pnu <> ''`)).rows) {
    const reg = cadastralToRegistryPnu(str(row.pnu));
    if (reg) cpc.set(str(row.complex_id), reg);
  }
  const recap = new Map<string, string[]>();
  for (const row of (await client.execute(`SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = 'BUILDING_HUB_RECAP'`)).rows) {
    const list = recap.get(str(row.complex_id)) ?? [];
    list.push(str(row.source_key));
    recap.set(str(row.complex_id), list);
  }

  const links: Array<{ complexId: string; kaptCode: string; via: string }> = [];
  let noCandidate = 0;
  let multi = 0;
  let already = 0;
  let considered = 0;
  for (const row of masters.rows) {
    const id = str(row.complex_id);
    if (have.has(id)) {
      already += 1;
      continue;
    }
    considered += 1;
    const recaps = [...new Set((recap.get(id) ?? []).filter((p) => /^\d{19}$/.test(p)))];
    const caches = [...(cache.get(id) ?? [])];
    let cpcPnu = cpc.get(id) ?? "";
    if (cpcPnu && cpcPnu.slice(0, 5) !== str(row.lawd_cd)) cpcPnu = "";
    const pnus = [...new Set([...recaps, ...caches, ...(cpcPnu ? [cpcPnu] : [])])];
    const master = masterJibun(str(row.jibun));
    const masterKey = master ? keyFromParts(str(row.lawd_cd) + str(row.bjdong_cd), master.san, master.bun, master.ji) : null;
    let parcel: ParcelKey | null = null;
    if (pnus.length === 1) parcel = keyFromPnu(pnus[0]!);
    else if (pnus.length === 0 && masterKey) parcel = masterKey;
    else if (pnus.length === 1 && masterKey && parcelKeyString(keyFromPnu(pnus[0]!)!) !== parcelKeyString(masterKey)) parcel = null;
    if (parcel && masterKey && parcelKeyString(parcel) !== parcelKeyString(masterKey)) parcel = null;
    const codes = new Set<string>();
    const vias = new Set<string>();
    if (parcel) {
      for (const code of byParcel.get(parcelKeyString(parcel)) ?? []) {
        codes.add(code);
        vias.add("jibun");
      }
    }
    const road = normalizeAddress(str(row.road_address));
    if (road) {
      for (const code of byRoad.get(road) ?? []) {
        codes.add(code);
        vias.add("road");
      }
    }
    if (codes.size === 0) noCandidate += 1;
    else if (codes.size > 1) multi += 1;
    else links.push({ complexId: id, kaptCode: [...codes][0]!, via: [...vias].sort().join("+") });
  }
  const byCode = new Map<string, number>();
  for (const link of links) byCode.set(link.kaptCode, (byCode.get(link.kaptCode) ?? 0) + 1);
  const unique = links.filter((link) => byCode.get(link.kaptCode) === 1);
  const codeMulti = links.length - unique.length;
  const summary = {
    at: new Date().toISOString(),
    list: readList().length,
    addressed,
    considered,
    alreadyLinked: already,
    noCandidate,
    multiCandidate: multi,
    oneToOneBeforeCodeCheck: links.length,
    codeSharedByComplexes: codeMulti,
    insert: unique.length,
    via: unique.reduce<Record<string, number>>((m, l) => {
      m[l.via] = (m[l.via] ?? 0) + 1;
      return m;
    }, {}),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/kapt-link-plan.json`, JSON.stringify({ summary, links: unique }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) return;
  const now = new Date().toISOString();
  let applied = 0;
  for (const link of unique) {
    const res = await client.execute({
      sql: `INSERT INTO apt_complex_source_links (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
            VALUES ('KAPT', ?, ?, ?, 'profile_fill_kapt_exact_2026_09', ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [link.kaptCode, link.complexId, JSON.stringify({ via: link.via, match: "exact_bjd_jibun_or_road" }), now, now],
    });
    applied += res.rowsAffected;
  }
  console.log(JSON.stringify({ applied }));
}

async function main() {
  const phase = process.argv[2] ?? "plan";
  if (phase === "list") await listPhase();
  else if (phase === "address") await addressPhase();
  else if (phase === "plan") await planPhase(false);
  else if (phase === "apply") await planPhase(true);
  else throw new Error(`unknown phase ${phase}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  });
}
