export const PRIMARY_NAV = [
  {
    href: "/",
    label: "시장",
    match: (pathname: string) => pathname === "/" || pathname.startsWith("/stats"),
  },
  {
    href: "/regions",
    label: "지역별 조회",
    match: (pathname: string) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
  {
    href: "/complexes",
    label: "단지별 조회",
    match: (pathname: string) =>
      pathname.startsWith("/complexes") || pathname.startsWith("/apt/"),
  },
  {
    href: "/map",
    label: "지도",
    match: (pathname: string) => pathname.startsWith("/map"),
  },
] as const;

/** 더보기 > 도구 — 학군(/school)은 비활성·메뉴 비노출 */
export const TOOL_NAV = [
  {
    href: "/transactions",
    label: "실거래 검색",
    match: (pathname: string) => pathname.startsWith("/transactions"),
  },
  {
    href: "/loan",
    label: "대출계산기",
    match: (pathname: string) => pathname.startsWith("/loan"),
  },
  {
    href: "/rates",
    label: "금리정보",
    match: (pathname: string) => pathname.startsWith("/rates"),
  },
  {
    href: "/lab",
    label: "오늘의 실험실",
    match: (pathname: string) => pathname.startsWith("/lab"),
  },
] as const;

/** 더보기 > 서비스 (보조) — 정책/FAQ는 Footer 전용 */
export const MORE_SERVICE_LINKS = [
  { href: "/about", label: "집랩 소개" },
  { href: "/contact", label: "문의하기" },
] as const;

export const UNIFIED_SEARCH_PLACEHOLDER =
  "아파트 단지 또는 지역을 검색하세요.";
