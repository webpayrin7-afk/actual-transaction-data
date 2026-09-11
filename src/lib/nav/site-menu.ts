import { INFO_NAV, LEGAL_NAV } from "@/lib/site";

export const PRIMARY_NAV = [
  {
    href: "/",
    label: "오늘의 시장",
    match: (pathname: string) => pathname === "/",
  },
  {
    href: "/complexes",
    label: "단지별 조회",
    match: (pathname: string) =>
      pathname.startsWith("/complexes") || pathname.startsWith("/apt/"),
  },
  {
    href: "/regions",
    label: "지역별 조회",
    match: (pathname: string) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
  {
    href: "/stats",
    label: "시장 동향",
    match: (pathname: string) => pathname.startsWith("/stats"),
  },
] as const;

/** 현재 활성화된 도구만 — 학군(/school)은 비활성·메뉴 비노출 */
export const TOOL_NAV = [
  {
    href: "/loan",
    label: "대출계산기",
    match: (pathname: string) => pathname.startsWith("/loan"),
  },
] as const;

export const MENU_INFO_LINKS = [...INFO_NAV, ...LEGAL_NAV] as const;
