import type { LucideIcon } from "lucide-react";
import {
  Building2,
  Grid2x2,
  HousePlus,
  Map,
  TrendingUp,
} from "lucide-react";

export type HomeQuickNavItem = {
  id: string;
  label: string;
  /** Short label for compact sticky bar */
  shortLabel: string;
  href: string | null;
  /** When href is null — shown disabled (e.g. map not shipped yet). */
  disabled?: boolean;
  disabledHint?: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
};

/**
 * Mobile home quick actions.
 */
export const HOME_QUICK_NAV: HomeQuickNavItem[] = [
  // 지도가 첫 화면(/) — 집랩의 핵심. 시장 홈은 /market
  {
    id: "map",
    label: "지도로 찾기",
    shortLabel: "지도",
    href: "/",
    icon: Map,
    match: (pathname) => pathname === "/" || pathname.startsWith("/map"),
  },
  {
    id: "market",
    label: "시장",
    shortLabel: "시장",
    href: "/market",
    icon: TrendingUp,
    match: (pathname) => pathname.startsWith("/market") || pathname.startsWith("/stats"),
  },
  {
    id: "regions",
    label: "지역조회",
    shortLabel: "지역",
    href: "/regions",
    icon: Grid2x2,
    match: (pathname) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
  {
    id: "complexes",
    label: "단지조회",
    shortLabel: "단지",
    href: "/complexes",
    icon: Building2,
    match: (pathname) =>
      pathname.startsWith("/complexes") || pathname.startsWith("/apt/"),
  },
  {
    id: "presale",
    label: "분양",
    shortLabel: "분양",
    href: "/presale",
    icon: HousePlus,
    match: (pathname) => pathname.startsWith("/presale"),
  },
];
