/** SchoolInfo (학교알리미) OpenAPI — server-only. */

export const BASE_URL = "https://www.schoolinfo.go.kr/openApi.do";
export const REVALIDATE_SECONDS = 86_400;

export type ApiType = "0" | "09" | "22" | "35" | "55" | "59";

export type FetchOpts = {
  apiType: ApiType;
  sidoCode: string;
  sggCode: string;
  schulKndCode: string;
  pbanYr?: number | string;
  /**
   * Required for some apiTypes (e.g. 35 급식비 집행 실적).
   * depthNo=20 → 학생 1인당 1식 식품비 (STDNT_ONE_PSNBY_LM).
   * depthNo=10 → 급식비 부담주체 금액/비율 only.
   */
  depthNo?: string;
};

/** Official depthNo for school-detail meal metric (1인당 1식 식품비). */
export const MEAL_DEPTH_NO = "20";

export type ApiBody = {
  resultCode: string;
  resultMsg?: string;
  list?: Record<string, unknown>[];
  [key: string]: unknown;
};

export function apiKey(): string | null {
  const key = process.env.SCHOOLINFO_API_KEY?.trim() || "";
  return key || null;
}

export function hasApiKey(): boolean {
  return apiKey() != null;
}

export async function fetchApi(opts: FetchOpts): Promise<{
  httpOk: boolean;
  httpStatus: number;
  body: ApiBody | null;
}> {
  const key = apiKey();
  if (!key) {
    return {
      httpOk: false,
      httpStatus: 0,
      body: {
        resultCode: "auth_hold",
        resultMsg: "SCHOOLINFO_API_KEY not configured",
        list: [],
      },
    };
  }

  const url = new URL(BASE_URL);
  url.searchParams.set("apiKey", key);
  url.searchParams.set("apiType", opts.apiType);
  url.searchParams.set("schulKndCode", opts.schulKndCode);
  url.searchParams.set("sidoCode", opts.sidoCode);
  url.searchParams.set("sggCode", opts.sggCode);
  if (opts.pbanYr != null) url.searchParams.set("pbanYr", String(opts.pbanYr));
  const depthNo =
    opts.depthNo ?? (opts.apiType === "35" ? MEAL_DEPTH_NO : undefined);
  if (depthNo) url.searchParams.set("depthNo", depthNo);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "ziplab-school-detail/1.0",
    },
    next: { revalidate: REVALIDATE_SECONDS },
  });

  let body: ApiBody | null = null;
  try {
    body = (await res.json()) as ApiBody;
  } catch {
    body = { resultCode: "fail", resultMsg: "invalid JSON", list: [] };
  }

  return { httpOk: res.ok, httpStatus: res.status, body };
}

export function isSuccess(body: ApiBody | null): boolean {
  if (!body) return false;
  const code = String(body.resultCode ?? "").toLowerCase();
  return code === "success" || code === "info-000";
}

export function listOf(body: ApiBody | null): Record<string, unknown>[] {
  return Array.isArray(body?.list) ? body!.list! : [];
}
