/**
 * 지역 현황 섹션의 범위: 구(시·군·구 lawd_cd) 전체 또는 그 안의 법정동 하나.
 *
 * 구 범위는 기존 API·캐시 키와 완전히 같게 유지한다(dong 없음 = 구).
 * 동 범위는 같은 계산을 `transactions.dong` / `apt_complex_master.legal_dong_name`
 * 으로 좁힌 값이다.
 */
export type RegionScope = {
  /**
   * 5자리 시·군·구 코드. 여러 구로 나뉜 시(성남·수원·고양 등) 전체는
   * 구 코드를 쉼표로 이은 값(예: "41131,41133,41135") — `regionScopeLawdCd`로 만든다.
   */
  lawdCd: string;
  /** 법정동 이름 (예: "잠실동"). 없으면 구 전체. 동 범위는 구 코드 하나만. */
  dong?: string | null;
};

const LAWD_RE = /^[0-9]{5}$/;
/** 구가 가장 많은 시는 4개(수원·화성). 여유를 두되 임의 목록은 막는다. */
const MAX_SCOPE_LAWD_CODES = 6;

/**
 * 지역 화면 범위 코드: 구 하나면 그 코드, 여러 구로 나뉜 시는 모든 구 코드를 쉼표로 잇는다.
 * (첫 구만 쓰면 성남시 화면이 수정구만 집계됐다.)
 */
export function regionScopeLawdCd(lawdCodes: readonly string[] | undefined): string | null {
  const codes = [...new Set((lawdCodes ?? []).map((c) => c.trim()).filter((c) => LAWD_RE.test(c)))];
  if (!codes.length || codes.length > MAX_SCOPE_LAWD_CODES) return null;
  return codes.join(",");
}

/** 범위 코드(`lawdCd`)의 구 코드 목록. */
export function scopeLawdCodes(lawdCd: string): string[] {
  return lawdCd.split(",");
}

/** 여러 구를 묶은 시 범위인지. */
export function isMultiLawdScope(lawdCd: string): boolean {
  return lawdCd.includes(",");
}

/** SQL 조건: 구 하나면 `col = ?`, 여러 구면 `col IN (?, …)`. 인자는 `scopeLawdCodes(lawdCd)`. */
export function lawdInSql(col: string, lawdCd: string): string {
  const n = scopeLawdCodes(lawdCd).length;
  return n === 1 ? `${col} = ?` : `${col} IN (${Array.from({ length: n }, () => "?").join(", ")})`;
}

/**
 * 매매만 거르는 조건. 여러 구(`lawd_cd IN (…)`)와 `deal_type = 'trade'`를 함께 쓰면 플래너가
 * idx_tx_type_first_seen(deal_type)으로 전국 매매를 훑는다(성남 3구 COUNT 85초). 여러 구일 때는
 * 단항 `+`로 deal_type 인덱스를 빼서 idx_tx_lawd_ym_type(lawd_cd, year_month, deal_type)을 쓰게 한다.
 * 구 하나는 기존 조건 그대로.
 */
export function tradeOnlySql(col: string, lawdCd: string): string {
  return isMultiLawdScope(lawdCd) ? `+${col} = 'trade'` : `${col} = 'trade'`;
}

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
  const raw = params.get("lawd_cd")?.trim() ?? "";
  const parts = raw.split(",");
  if (!parts.every((c) => LAWD_RE.test(c))) return { error: "lawd_cd가 필요합니다." };
  const lawdCd = regionScopeLawdCd(parts);
  if (!lawdCd || lawdCd !== raw) return { error: "lawd_cd가 필요합니다." };
  const rawDong = params.get("dong");
  if (rawDong == null || rawDong.trim() === "") return { scope: { lawdCd } };
  if (isMultiLawdScope(lawdCd)) return { error: "동 범위는 구 코드 하나만 받습니다." };
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
