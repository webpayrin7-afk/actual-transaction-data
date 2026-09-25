/**
 * 지역 현황 섹션의 범위: 구(시·군·구 lawd_cd) 전체 또는 그 안의 법정동 하나.
 *
 * 구 범위는 기존 API·캐시 키와 완전히 같게 유지한다(dong 없음 = 구).
 * 동 범위는 같은 계산을 `transactions.dong` / `apt_complex_master.legal_dong_name`
 * 으로 좁힌 값이다.
 */
export type RegionScope = {
  /** 5자리 시·군·구 코드. */
  lawdCd: string;
  /** 법정동 이름 (예: "잠실동"). 없으면 구 전체. */
  dong?: string | null;
};

const LAWD_RE = /^[0-9]{5}$/;
/** 법정동 이름: 한글·숫자·가운뎃점 (예: 잠실동, 을지로1가, 신당동). */
const DONG_RE = /^[가-힣0-9·.]{1,20}$/;

export function normalizeDongName(raw: string | null | undefined): string | null {
  const dong = (raw ?? "").replace(/\s+/g, "").trim();
  return dong && DONG_RE.test(dong) ? dong : null;
}

/**
 * 읍·면 리 이름(예: "가평읍 대곡리")은 DB에 공백 하나로 저장돼 있다.
 * 동 화면·동 범위 API는 공백을 하나로 모아 남긴다(`normalizeDongName`은 공백을 지운 저장 키용).
 */
const SCOPE_DONG_RE = /^[가-힣0-9·.]{1,20}( [가-힣0-9·.]{1,20})?$/;

export function normalizeScopeDongName(raw: string | null | undefined): string | null {
  const dong = (raw ?? "").replace(/\s+/g, " ").trim();
  return dong && SCOPE_DONG_RE.test(dong) ? dong : null;
}

export function isDongScope(scope: RegionScope): scope is RegionScope & { dong: string } {
  return Boolean(scope.dong);
}

/** React Query / 메모리 캐시 키. 구 범위는 기존 키(lawdCd)와 같다. */
export function regionScopeKey(scope: RegionScope): string {
  return scope.dong ? `${scope.lawdCd}|${scope.dong}` : scope.lawdCd;
}

/** API 쿼리스트링 (`lawd_cd=…[&dong=…]`). */
export function regionScopeParams(scope: RegionScope): string {
  const qs = new URLSearchParams({ lawd_cd: scope.lawdCd });
  if (scope.dong) qs.set("dong", scope.dong);
  return qs.toString();
}

/**
 * API 요청의 `lawd_cd` + 선택 `dong`을 읽는다.
 * lawd_cd가 없거나 dong 값이 잘못되면 오류 문구를 돌려준다.
 */
export function parseRegionScope(
  params: URLSearchParams,
): { scope: RegionScope; error?: undefined } | { scope?: undefined; error: string } {
  const lawdCd = params.get("lawd_cd")?.trim() ?? "";
  if (!LAWD_RE.test(lawdCd)) return { error: "lawd_cd가 필요합니다." };
  const rawDong = params.get("dong");
  if (rawDong == null || rawDong.trim() === "") return { scope: { lawdCd } };
  const dong = normalizeScopeDongName(rawDong);
  if (!dong) return { error: "dong 값이 올바르지 않습니다." };
  return { scope: { lawdCd, dong } };
}

/**
 * 동 범위 거래 행을 읽는 공통 FROM 절.
 *
 * `idx_tx_lawd_ym_type`(lawd_cd, year_month, deal_type)로 구 전체를 훑고 dong을 거르면
 * 구 크기만큼 행을 읽는다. 동은 단지 마스터(lawd_cd + 법정동)에서 단지를 먼저 고르고
 * `idx_tx_lawd_apt_ym`(lawd_cd, apt_name_norm, year_month)로 그 단지 거래만 읽는다.
 * 마스터에 매칭된 단지 거래만 포함한다(구 시세·전세 계산과 같은 기준).
 *
 * 별칭: 마스터 `m`, 거래 `t`. 인자: [lawdCd, dong, fromYm].
 */
export const DONG_TX_FROM = `apt_complex_master m
  CROSS JOIN transactions t
    ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
   AND t.dong = m.legal_dong_name`;
export const DONG_TX_WHERE = `m.lawd_cd = ? AND m.legal_dong_name = ? AND t.year_month >= ?`;
