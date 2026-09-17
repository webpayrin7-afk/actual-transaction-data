/**
 * Public schoolinfo.go.kr detail page URL.
 * Prefer SHL_IDF_CD (UUID from apiType0). Fallback: HG_CD from SCHUL_CODE
 * (Seoul S01… → B10…).
 */

const SCHOOLINFO_DETAIL =
  "https://www.schoolinfo.go.kr/ei/ss/Pneiss_b01_s0.do";

/** Official SchoolInfo home — provider attribution only (not school-specific). */
export const SCHOOLINFO_HOME_URL = "https://www.schoolinfo.go.kr/";

export function schoolInfoPublicUrl(opts: {
  shlIdfCd?: string | null;
  schoolInfoCode?: string | null;
}): string | null {
  const id = opts.shlIdfCd?.trim();
  if (id && id.toLowerCase() !== "null") {
    return `${SCHOOLINFO_DETAIL}?SHL_IDF_CD=${encodeURIComponent(id)}`;
  }

  const code = opts.schoolInfoCode?.trim();
  if (!code) return null;

  const hgCd = code.startsWith("S01") ? `B10${code.slice(3)}` : code;
  return `${SCHOOLINFO_DETAIL}?HG_CD=${encodeURIComponent(hgCd)}`;
}
