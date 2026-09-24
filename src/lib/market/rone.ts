import "server-only";

/**
 * 한국부동산원 R-ONE 부동산통계 Open API (read-only).
 * 월간 전국주택가격동향조사 표를 지역(CLS_ID)별 전체 기간으로 한 번에 받는다.
 * 원 자료는 월 1회 갱신되므로 fetch 캐시(12시간)로 재사용한다.
 */
const RONE_ENDPOINT = "https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do";
const RONE_REVALIDATE_SECONDS = 43_200;

export const RONE_TABLES = {
  /** (월) 매매가격지수_아파트 — 2003.11~ */
  tradeIndex: "A_2024_00045",
  /** (월) 전세가격지수_아파트 — 2003.11~ */
  jeonseIndex: "A_2024_00050",
  /** (월) 중위매매가격_아파트 (천원) — 2012.01~ */
  medianTradePrice: "A_2024_00062",
  /** (월) 평균 매매가격 대비 전세가격_아파트 (%) — 2012.01~ */
  jeonseRatio: "A_2024_00072",
} as const;

export type RoneTable = keyof typeof RONE_TABLES;

export type RonePoint = { ym: string; value: number };

type RoneRow = {
  WRTTIME_IDTFR_ID?: string;
  DTA_VAL?: number | string | null;
  ITM_ID?: number;
};

export class RoneUnavailableError extends Error {}

export function hasRoneKey(): boolean {
  return Boolean(process.env.RONE_API_KEY?.trim());
}

/** 한 표·한 지역의 월별 전체 시계열 (오름차순). */
export async function fetchRoneSeries(table: RoneTable, clsId: number): Promise<RonePoint[]> {
  const key = process.env.RONE_API_KEY?.trim();
  if (!key) throw new RoneUnavailableError("RONE_API_KEY missing");
  const url = new URL(RONE_ENDPOINT);
  url.searchParams.set("KEY", key);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", "1000");
  url.searchParams.set("STATBL_ID", RONE_TABLES[table]);
  url.searchParams.set("DTACYCLE_CD", "MM");
  url.searchParams.set("CLS_ID", String(clsId));

  const res = await fetch(url, {
    next: { revalidate: RONE_REVALIDATE_SECONDS, tags: ["rone"] },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new RoneUnavailableError(`R-ONE HTTP ${res.status}`);
  const body = (await res.json()) as {
    SttsApiTblData?: [unknown, { row?: RoneRow[] }?];
    RESULT?: { CODE?: string };
  };
  const rows = body.SttsApiTblData?.[1]?.row;
  if (!Array.isArray(rows)) throw new RoneUnavailableError("R-ONE empty response");

  const out: RonePoint[] = [];
  for (const r of rows) {
    const ym = String(r.WRTTIME_IDTFR_ID ?? "");
    const v = typeof r.DTA_VAL === "number" ? r.DTA_VAL : Number(r.DTA_VAL);
    if (!/^\d{6}$/.test(ym) || !Number.isFinite(v)) continue;
    out.push({ ym, value: v });
  }
  out.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  return out;
}

/** 동시 호출 수를 제한해 여러 지역을 받는다. 실패한 지역은 null. */
export async function fetchRoneSeriesMany(
  table: RoneTable,
  clsIds: number[],
  concurrency = 6,
): Promise<Map<number, RonePoint[] | null>> {
  const out = new Map<number, RonePoint[] | null>();
  let cursor = 0;
  async function worker() {
    while (cursor < clsIds.length) {
      const id = clsIds[cursor++]!;
      try {
        out.set(id, await fetchRoneSeries(table, id));
      } catch (error) {
        console.warn("[rone]", table, id, error instanceof Error ? error.message : error);
        out.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, clsIds.length) }, worker));
  return out;
}
