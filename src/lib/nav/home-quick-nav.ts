import type { LucideIcon } from "lucide-react";
import {
  Building2,
  ChartColumn,
  Grid2x2,
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
  {
    id: "market",
    label: "오늘의 시장",
    shortLabel: "오늘 시장",
    href: "/",
    icon: TrendingUp,
    match: (pathname) => pathname === "/",
  },
  {
    id: "map",
    label: "지도로 찾기",
    shortLabel: "지도",
    href: "/map",
    icon: Map,
    match: (pathname) => pathname.startsWith("/map"),
  },
  {
    id: "regions",
    label: "지역조회",
    shortLabel: "지역조회",
    href: "/regions",
    icon: Grid2x2,
    match: (pathname) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
  {
    id: "complexes",
    label: "단지조회",
    shortLabel: "단지조회",
    href: "/complexes",
    icon: Building2,
    match: (pathname) =>
      pathname.startsWith("/complexes") || pathname.startsWith("/apt/"),
  },
  {
    id: "stats",
    label: "시장동향",
    shortLabel: "시장동향",
    href: "/stats",
    icon: ChartColumn,
    match: (pathname) => pathname.startsWith("/stats"),
  },
];
