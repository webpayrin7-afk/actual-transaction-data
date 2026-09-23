/**
 * Official source clients for the supply fill:
 *  - 건축HUB 건축물대장정보 서비스 getBrExposPubuseAreaInfo (data.go.kr, MOLIT_API_KEY)
 *  - VWorld 주소 → 좌표 (parcel) geocoder, used only to read the official 19-digit PNU
 *    (refined.structure.level4LC) for a parcel address built from 실거래 jibun.
 *
 * Every response page is cached on disk so reruns never repeat a successful call.
 * Keys are never printed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseParcelJibun, type ExposRow } from "../../src/lib/unit-type/official-expos";

export const CACHE_ROOT = "data/supply-fill-cache";
const PAGE_SIZE = 100; // API caps numOfRows at 100.
const MAX_ATTEMPTS = 6;
const PAGE_PARALLEL = 4;

export class QuotaError extends Error {
  constructor(message = "QUOTA") {
    super(message);
  }
}

export const apiStats = { calls: 0, retries: 0, http503: 0, http429: 0, cachedPages: 0, vworldCalls: 0 };

let spacingMs = Number(process.env.SUPPLY_FILL_SPACING_MS ?? 120);
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + spacingMs;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Parcel = { sigunguCd: string; bjdongCd: string; platGbCd: string; bun: string; ji: string };

export function parcelFromRegistryPnu(pnu: string): Parcel | null {
  if (!/^\d{19}$/.test(pnu)) return null;
  const platGbCd = pnu.slice(10, 11);
  if (platGbCd !== "0" && platGbCd !== "1") return null;
  return { sigunguCd: pnu.slice(0, 5), bjdongCd: pnu.slice(5, 10), platGbCd, bun: pnu.slice(11, 15), ji: pnu.slice(15, 19) };
}

/** 연속지적도/VWorld PNU (대지=1, 산=2) → 건축HUB parcel key convention (대지=0, 산=1). */
export function cadastralToRegistryPnu(pnu: string): string {
  if (!/^\d{19}$/.test(pnu)) return "";
  const land = pnu[10];
  const plat = land === "1" ? "0" : land === "2" ? "1" : "";
  if (!plat) return "";
  return `${pnu.slice(0, 10)}${plat}${pnu.slice(11)}`;
}

/** Accept a VWorld PNU only when sigungu code, 법정동 name and bun/ji all equal the input parcel. */
export function acceptVworld(
  input: { lawdCd: string; dong: string; jibun: string },
  v: { status: string; pnu: string; level4L: string; text: string },
): { ok: boolean; reason: string; registryPnu: string } {
  if (v.status !== "OK") return { ok: false, reason: `VWORLD_${v.status}`, registryPnu: "" };
  const registryPnu = cadastralToRegistryPnu(v.pnu);
  if (!registryPnu) return { ok: false, reason: "VWORLD_BAD_PNU", registryPnu: "" };
  if (registryPnu.slice(0, 5) !== input.lawdCd) return { ok: false, reason: "VWORLD_SIGUNGU_MISMATCH", registryPnu: "" };
  const parcel = parseParcelJibun(input.jibun);
  if (!parcel) return { ok: false, reason: "BAD_JIBUN", registryPnu: "" };
  if (registryPnu.slice(10) !== `${parcel.platGbCd}${parcel.bun}${parcel.ji}`) {
    return { ok: false, reason: "VWORLD_PARCEL_MISMATCH", registryPnu: "" };
  }
  const tokens = input.dong.split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? "";
  if (head !== v.level4L) return { ok: false, reason: "VWORLD_DONG_MISMATCH", registryPnu: "" };
  if (!tokens.every((t) => v.text.includes(t))) return { ok: false, reason: "VWORLD_DONG_MISMATCH", registryPnu: "" };
  return { ok: true, reason: "OK", registryPnu };
}

function quotaText(text: string): boolean {
  return /LIMITED_NUMBER_OF_SERVICE_REQUESTS|한도|트래픽|"returnReasonCode"\s*:\s*"22"/.test(text);
}

async function fetchExposPage(parcel: Parcel, page: number): Promise<{ total: number; items: ExposRow[] }> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const qs = new URLSearchParams({
    sigunguCd: parcel.sigunguCd,
    bjdongCd: parcel.bjdongCd,
    platGbCd: parcel.platGbCd,
    bun: parcel.bun,
    ji: parcel.ji,
    numOfRows: String(PAGE_SIZE),
    pageNo: String(page),
    _type: "json",
  });
  let last = "unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await pace();
    apiStats.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(
        `https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?serviceKey=${encodeURIComponent(key)}&${qs}`,
        { headers: { "User-Agent": "ziplab-supply-fill" }, signal: controller.signal },
      );
      const text = await res.text();
      if (quotaText(text)) throw new QuotaError();
      if (res.status === 429) {
        apiStats.http429 += 1;
        spacingMs = Math.min(3000, Math.round(spacingMs * 1.6));
        last = "429";
      } else if (!res.ok) {
        if (res.status === 503) apiStats.http503 += 1;
        last = `HTTP ${res.status}`;
      } else {
        let parsed: { response?: { header?: { resultCode?: string }; body?: { totalCount?: unknown; items?: { item?: unknown } } } };
        try {
          parsed = JSON.parse(text);
        } catch {
          last = "non-json";
          parsed = {};
        }
        const code = String(parsed.response?.header?.resultCode ?? "");
        if (parsed.response && (code === "00" || code === "0" || code === "000" || code === "03")) {
          const raw = parsed.response.body?.items?.item;
          const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as ExposRow[];
          return { total: Number(parsed.response.body?.totalCount ?? 0) || 0, items };
        }
        if (parsed.response) last = `API ${code}`;
      }
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      last = error instanceof Error && error.name === "AbortError" ? "timeout" : "network";
    } finally {
      clearTimeout(timer);
    }
    apiStats.retries += 1;
    await sleep(700 * (attempt + 1));
  }
  throw new Error(last);
}

export type ExposFetch = { pnu: string; total: number; pages: number; rows: ExposRow[]; complete: boolean };

/** All 전유공용면적 rows for one registry parcel. Resumable page cache per PNU. */
export async function fetchExposParcel(pnu: string): Promise<ExposFetch> {
  const parcel = parcelFromRegistryPnu(pnu);
  if (!parcel) throw new Error(`bad pnu ${pnu}`);
  const dir = `${CACHE_ROOT}/expos/${pnu}`;
  mkdirSync(dir, { recursive: true });
  const metaPath = `${dir}/meta.json`;
  let total = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as { total: number }).total : -1;
  if (total < 0) {
    const first = await fetchExposPage(parcel, 1);
    total = first.total;
    writeFileSync(`${dir}/p1.json`, JSON.stringify(first.items));
    writeFileSync(metaPath, JSON.stringify({ total, fetchedAt: new Date().toISOString() }));
  } else apiStats.cachedPages += 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total > 60000) throw new Error(`page volume ${total}`);
  const missing: number[] = [];
  for (let page = 2; page <= pages; page += 1) {
    if (existsSync(`${dir}/p${page}.json`)) apiStats.cachedPages += 1;
    else missing.push(page);
  }
  for (let i = 0; i < missing.length; i += PAGE_PARALLEL) {
    const group = missing.slice(i, i + PAGE_PARALLEL);
    await Promise.all(
      group.map(async (page) => {
        const got = await fetchExposPage(parcel, page);
        writeFileSync(`${dir}/p${page}.json`, JSON.stringify(got.items));
      }),
    );
  }
  return readExposCache(pnu)!;
}

/** Page 1 only: gives totalCount (cost of the full fetch) and a first look at names/uses. */
export async function probeExposParcel(pnu: string): Promise<{ total: number; first: ExposRow[] }> {
  const parcel = parcelFromRegistryPnu(pnu);
  if (!parcel) throw new Error(`bad pnu ${pnu}`);
  const dir = `${CACHE_ROOT}/expos/${pnu}`;
  const metaPath = `${dir}/meta.json`;
  if (existsSync(metaPath) && existsSync(`${dir}/p1.json`)) {
    apiStats.cachedPages += 1;
    return {
      total: (JSON.parse(readFileSync(metaPath, "utf8")) as { total: number }).total,
      first: JSON.parse(readFileSync(`${dir}/p1.json`, "utf8")) as ExposRow[],
    };
  }
  mkdirSync(dir, { recursive: true });
  const got = await fetchExposPage(parcel, 1);
  writeFileSync(`${dir}/p1.json`, JSON.stringify(got.items));
  writeFileSync(metaPath, JSON.stringify({ total: got.total, fetchedAt: new Date().toISOString() }));
  return { total: got.total, first: got.items };
}

/** Read a cached parcel without any network call. Null when not fetched yet. */
export function readExposCache(pnu: string): ExposFetch | null {
  const dir = `${CACHE_ROOT}/expos/${pnu}`;
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) return null;
  const total = (JSON.parse(readFileSync(metaPath, "utf8")) as { total: number }).total;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: ExposRow[] = [];
  let have = 0;
  for (const name of readdirSync(dir)) {
    const match = /^p(\d+)\.json$/.exec(name);
    if (!match) continue;
    have += 1;
    rows.push(...(JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as ExposRow[]));
  }
  return { pnu, total, pages, rows, complete: have >= pages };
}

export type VworldParcel = { status: "OK" | "NOT_FOUND" | "ERROR"; pnu: string; level2: string; level4L: string; text: string; detail: string };

/** VWorld parcel geocode. Returns the official cadastral PNU (level4LC). Cached per address. */
export async function vworldParcel(address: string): Promise<VworldParcel> {
  const dir = `${CACHE_ROOT}/vworld`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${Buffer.from(address).toString("base64url")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as VworldParcel;
  const key = process.env.VWORLD_API_KEY?.trim();
  if (!key) throw new Error("VWORLD_API_KEY missing");
  const qs = new URLSearchParams({
    service: "address",
    request: "getcoord",
    version: "2.0",
    crs: "epsg:4326",
    address,
    refine: "true",
    simple: "false",
    format: "json",
    type: "parcel",
    key,
  });
  let out: VworldParcel = { status: "ERROR", pnu: "", level2: "", level4L: "", text: "", detail: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    apiStats.vworldCalls += 1;
    try {
      const res = await fetch(`https://api.vworld.kr/req/address?${qs}`);
      const json = (await res.json()) as {
        response?: {
          status?: string;
          error?: { code?: string };
          refined?: { text?: string; structure?: Record<string, string> };
        };
      };
      const status = json.response?.status;
      if (status === "OK") {
        const s = json.response?.refined?.structure ?? {};
        out = {
          status: "OK",
          pnu: String(s.level4LC ?? ""),
          level2: String(s.level2 ?? ""),
          level4L: String(s.level4L ?? ""),
          text: String(json.response?.refined?.text ?? ""),
          detail: String(s.detail ?? ""),
        };
        break;
      }
      if (status === "NOT_FOUND") {
        out = { ...out, status: "NOT_FOUND" };
        break;
      }
      if (json.response?.error?.code === "OVER_REQUEST_LIMIT") throw new QuotaError("VWORLD_QUOTA");
    } catch (error) {
      if (error instanceof QuotaError) throw error;
    }
    await sleep(500 * (attempt + 1));
  }
  if (out.status !== "ERROR") writeFileSync(file, JSON.stringify(out));
  return out;
}
