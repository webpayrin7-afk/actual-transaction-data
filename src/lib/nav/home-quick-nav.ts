import type { LucideIcon } from "lucide-react";
import {
  Building2,
  ChartColumn,
  Grid2x2,
  LayoutDashboard,
  Map,
} from "lucide-react";

export type HomeQuickNavItem = {
  id: string;
  /** Expanded-row label */
  label: string;
  /** Compact one-line label */
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
 * TODO(map): wire "지도로 찾기" when a map route ships — do not invent /map here.
 */
export const HOME_QUICK_NAV: HomeQuickNavItem[] = [
  {
    id: "market",
    label: "오늘",
    shortLabel: "오늘",
    href: "/",
    icon: LayoutDashboard,
    match: (pathname) => pathname === "/",
  },
  {
    id: "map",
    label: "지도로 찾기",
    shortLabel: "지도",
    href: null,
    disabled: true,
    disabledHint: "준비중",
    icon: Map,
    match: () => false,
  },
  {
    id: "complexes",
    label: "단지",
    shortLabel: "단지",
    href: "/complexes",
    icon: Building2,
    match: (pathname) =>
      pathname.startsWith("/complexes") || pathname.startsWith("/apt/"),
  },
  {
    id: "regions",
    label: "지역",
    shortLabel: "지역",
    href: "/regions",
    icon: Grid2x2,
    match: (pathname) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
  {
    id: "stats",
    label: "시장",
    shortLabel: "시장",
    href: "/stats",
    icon: ChartColumn,
    match: (pathname) => pathname.startsWith("/stats"),
  },
];
