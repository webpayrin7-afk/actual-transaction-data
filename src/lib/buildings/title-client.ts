import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ParcelRef, TitleRow } from "./types";
import { parcelKey } from "./parcel";

const TITLE_URL = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo";
const CACHE_DIR = join(process.cwd(), "data/cache/building-title");

export type TitleFetchResult = {
  parcelKey: string;
  totalCount: number;
  items: TitleRow[];
  pages: number;
  apiCalls: number;
  fromCache: boolean;
  sourceAsOf: string;
};

function serviceKey(): string {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) throw new Error("MOLIT_API_KEY missing");
  return raw;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key.replace(/\|/g, "_")}.json`);
}

export function readTitleCache(key: string): TitleFetchResult | null {
  const p = cachePath(key);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as TitleFetchResult;
    if (parsed && Array.isArray(parsed.items)) return parsed;
  } catch {
    return null;
  }
  return null;
}

export function writeTitleCache(result: TitleFetchResult): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const safe = result.items.every((row) => {
    const pk = String(row.mgmBldrgstPk ?? "").trim();
    return !pk || /^\d{6,32}$/.test(pk);
  });
  if (!safe) throw new Error("refusing to cache imprecise building PKs");
  writeFileSync(cachePath(result.parcelKey), JSON.stringify(result));
}

export function cacheHasPrecisePks(result: TitleFetchResult): boolean {
  return result.items.every((row) => {
    const pk = String(row.mgmBldrgstPk ?? "").trim();
    return !pk || /^\d{6,32}$/.test(pk);
  });
}

function parseItems(payload: unknown): { totalCount: number; items: TitleRow[] } {
  const root = payload as {
    response?: {
      header?: { resultCode?: string; resultMsg?: string };
      body?: {
        totalCount?: number | string;
        items?: { item?: TitleRow | TitleRow[] } | string;
      };
    };
  };
  const header = root.response?.header;
  const code = header?.resultCode;
  if (code && code !== "00" && code !== "000") {
    throw new Error(`title API ${code} ${header?.resultMsg ?? ""}`.trim());
  }
  const body = root.response?.body;
  const totalCount = Number(body?.totalCount ?? 0);
  const raw = body?.items;
  if (!raw || raw === "" || typeof raw === "string") {
    return { totalCount: Number.isFinite(totalCount) ? totalCount : 0, items: [] };
  }
  const item = raw.item;
  const items = item == null ? [] : Array.isArray(item) ? item : [item];
  return { totalCount: Number.isFinite(totalCount) ? totalCount : items.length, items };
}

function parseXmlItems(xml: string): { totalCount: number; items: TitleRow[] } {
  const resultCode = xml.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1];
  const resultMsg = xml.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1];
  if (resultCode && resultCode !== "00" && resultCode !== "000") {
    throw new Error(`title API ${resultCode} ${resultMsg ?? ""}`.trim());
  }
  const totalCount = Number(xml.match(/<totalCount>([^<]*)<\/totalCount>/)?.[1] ?? 0);
  const items: TitleRow[] = [];
  for (const block of xml.split(/<item>/).slice(1)) {
    const body = block.split(/<\/item>/)[0] ?? "";
    const row: Record<string, string> = {};
    for (const m of body.matchAll(/<([a-zA-Z0-9]+)>([^<]*)<\/\1>/g)) {
      row[m[1]] = m[2];
    }
    items.push(row);
  }
  return { totalCount: Number.isFinite(totalCount) ? totalCount : items.length, items };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function fetchTitlePage(
  parcel: ParcelRef,
  pageNo: number,
  numOfRows = 100,
): Promise<{ totalCount: number; items: TitleRow[] }> {
  const key = serviceKey();
  const qs = new URLSearchParams({
    sigunguCd: parcel.sigunguCd,
    bjdongCd: parcel.bjdongCd,
    platGbCd: parcel.platGbCd,
    bun: parcel.bun,
    ji: parcel.ji,
    numOfRows: String(numOfRows),
    pageNo: String(pageNo),
  });
  const url = `${TITLE_URL}?serviceKey=${encodeURIComponent(key)}&${qs.toString()}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ziplab-building-topology" },
        signal: ac.signal,
      });
      const text = await res.text();
      if (res.status === 429) {
        lastError = new Error("429");
        await sleep(4000 * (attempt + 1));
        continue;
      }
      if (res.status >= 500 || res.status === 0) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 180)}`);
      if (!text.trim()) {
        lastError = new Error("empty body");
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      // JSON numbers lose 건축물대장 PK precision past 16 digits. XML keeps strings.
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
        lastError = new Error("json title payload rejected");
        await sleep(500);
        continue;
      }
      return parseXmlItems(text);
    } catch (error) {
      lastError = error;
      await sleep(2000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchTitleParcel(
  parcel: ParcelRef,
  opts: { force?: boolean } = {},
): Promise<TitleFetchResult> {
  const key = parcelKey(parcel);
  if (!opts.force) {
    const cached = readTitleCache(key);
    if (cached && cacheHasPrecisePks(cached)) return { ...cached, fromCache: true, apiCalls: 0 };
  }
  const first = await fetchTitlePage(parcel, 1);
  const items = [...first.items];
  let apiCalls = 1;
  const total = first.totalCount;
  let page = 2;
  while (items.length < total) {
    const next = await fetchTitlePage(parcel, page);
    apiCalls += 1;
    if (next.items.length === 0) break;
    items.push(...next.items);
    page += 1;
    if (page > 50) break;
  }
  const sourceAsOf = items
    .map((row) => String(row.crtnDay ?? "").trim())
    .filter(Boolean)
    .sort()
    .at(-1) || new Date().toISOString().slice(0, 10);
  const result: TitleFetchResult = {
    parcelKey: key,
    totalCount: total,
    items,
    pages: page - 1,
    apiCalls,
    fromCache: false,
    sourceAsOf,
  };
  writeTitleCache(result);
  return result;
}
