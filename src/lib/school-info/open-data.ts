/**
 * SchoolInfo openData.do JSON feed (server-only).
 *
 * apiType 52 is NOT available via openApi.do (returns fail for sgg scope).
 * Use openData.do for 13-다 졸업생의 진로 현황.
 */

import "server-only";

import { REVALIDATE_SECONDS } from "@/lib/school-info/client";

export const OPEN_DATA_URL = "https://www.schoolinfo.go.kr/openData.do";

export type OpenDataKindCode = "02" | "03" | "04";

type CacheEntry = {
  expiresAt: number;
  rows: Record<string, unknown>[];
  httpOk: boolean;
  resultCode: string | null;
};

const listCache = new Map<string, CacheEntry>();

function cacheKey(p: {
  apiType: string;
  year: number;
  kindCode: OpenDataKindCode;
  sidoCode: string;
}): string {
  // openData often ignores sgg; key by sido+kind+year+apiType.
  return `opendata:${p.apiType}:${p.year}:${p.kindCode}:${p.sidoCode}`;
}

export async function fetchOpenDataList(p: {
  apiType: string;
  year: number;
  kindCode: OpenDataKindCode;
  sidoCode: string;
  sggCode?: string;
}): Promise<{
  httpOk: boolean;
  resultCode: string | null;
  list: Record<string, unknown>[];
}> {
  const key = cacheKey(p);
  const hit = listCache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return {
      httpOk: hit.httpOk,
      resultCode: hit.resultCode,
      list: hit.rows,
    };
  }

  const url = new URL(OPEN_DATA_URL);
  url.searchParams.set("openDataType", "json");
  url.searchParams.set("apiType", p.apiType);
  url.searchParams.set("pbanYr", String(p.year));
  url.searchParams.set("schulKndCode", p.kindCode);
  url.searchParams.set("sidoCode", p.sidoCode);
  if (p.sggCode) url.searchParams.set("sggCode", p.sggCode);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "ziplab-school-advancement/1.0",
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });
    const body = (await res.json()) as {
      resultCode?: string;
      resultMsg?: string;
      list?: Record<string, unknown>[];
    };
    const list = Array.isArray(body.list) ? body.list : [];
    const resultCode =
      body.resultCode != null
        ? String(body.resultCode)
        : list.length > 0
          ? "success"
          : "empty";
    const httpOk = res.ok && list.length > 0;
    listCache.set(key, {
      expiresAt: Date.now() + REVALIDATE_SECONDS * 1000,
      rows: list,
      httpOk,
      resultCode,
    });
    return { httpOk, resultCode, list };
  } catch {
    return { httpOk: false, resultCode: "error", list: [] };
  }
}

export function pickOpenDataRow(
  rows: Record<string, unknown>[],
  schoolInfoCode: string,
): Record<string, unknown> | null {
  const code = schoolInfoCode.trim();
  if (!code) return null;
  for (const row of rows) {
    const c = String(row.SCHUL_CODE ?? "").trim();
    if (c === code) return row;
  }
  return null;
}
