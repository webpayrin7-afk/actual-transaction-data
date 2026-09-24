/** 청약홈 분양정보 (공공데이터포털 odcloud) 페이지 수집. 키는 MOLIT_API_KEY(공공데이터포털 계정 키). */
const BASE = "https://api.odcloud.kr/api";
export const APPLYHOME_ENDPOINTS = {
  notices: "ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail",
  models: "ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl",
  competition: "ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet",
  /** 무순위 · 잔여세대 · 취소후재공급 */
  remndrNotices: "ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail",
  remndrModels: "ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancMdl",
  remndrCompetition: "ApplyhomeInfoCmpetRtSvc/v1/getRemndrLttotPblancCmpet",
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchAllPages(
  endpoint: string,
  serviceKey: string,
  perPage = 1000,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page++) {
    let body: { data?: Array<Record<string, unknown>>; totalCount?: number } | null = null;
    for (let attempt = 0; attempt < 5 && !body; attempt++) {
      const res = await fetch(
        `${BASE}/${endpoint}?page=${page}&perPage=${perPage}&serviceKey=${encodeURIComponent(serviceKey)}`,
      );
      if (res.status === 429 || res.status >= 500) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`${endpoint} page ${page}: HTTP ${res.status}`);
      body = await res.json();
    }
    if (!body) throw new Error(`${endpoint} page ${page}: retries exhausted`);
    const rows = body.data ?? [];
    out.push(...rows);
    if (rows.length < perPage || out.length >= (body.totalCount ?? 0)) break;
  }
  return out;
}
