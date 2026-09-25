"use client";

import Link from "next/link";
import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, Map, MapPinned } from "lucide-react";
import { MOBILE_DOCK_SPACER, MobileDock } from "@/components/layout/MobileDock";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { BrandLogo } from "@/components/layout/BrandLogo";

const NAV = [
  {
    href: "/",
    label: "시장",
    icon: BarChart3,
    match: (p: string) => p === "/" || p.startsWith("/stats"),
  },
  {
    href: "/regions",
    label: "지역별 조회",
    icon: MapPinned,
    match: (p: string) => p === "/regions" || p.startsWith("/region/"),
  },
  {
    href: "/complexes",
    label: "단지별 조회",
    icon: Building2,
    match: (p: string) =>
      p.startsWith("/complexes") || p.startsWith("/apt/"),
  },
  {
    href: "/map",
    label: "지도로 찾기",
    icon: Map,
    match: (p: string) => p.startsWith("/map"),
  },
] as const;

/**
 * /apt/[name] only (not /transactions, /calculator, …).
 * Complex detail uses its own top bar as the page chrome.
 */
export function isAptDetailFullPagePath(pathname: string): boolean {
  return /^\/apt\/[^/]+\/?$/.test(pathname);
}

/** /school/[schoolCode] — school detail own chrome (no global header/nav). */
export function isSchoolDetailFullPagePath(pathname: string): boolean {
  return /^\/school\/[^/]+\/?$/.test(pathname);
}

export function isDetailFullPagePath(pathname: string): boolean {
  return (
    isAptDetailFullPagePath(pathname) || isSchoolDetailFullPagePath(pathname)
  );
}

/** /complex-3d/[id] — 화면 전체를 3D 캔버스로 (헤더·사이드바·푸터·독 없음) */
export function isImmersivePath(pathname: string): boolean {
  return /^\/complex-3d\/[^/]+\/?$/.test(pathname);
}

/** 메인 메뉴(하단 독) 화면만 상단바·사이드바를 둔다. 나머지는 단지 상세처럼 자기 제목줄(← 뒤로)로. */
const MAIN_MENU_PATHS = new Set(["/", "/map", "/regions", "/complexes", "/presale"]);
export function isMainMenuPath(pathname: string): boolean {
  return MAIN_MENU_PATHS.has(pathname.replace(/\/+$/, "") || "/");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const immersive = isImmersivePath(pathname);
  const fullPage = immersive || isDetailFullPagePath(pathname) || !isMainMenuPath(pathname);

  // Sync before paint so sticky offsets don't briefly assume global header height.
  useLayoutEffect(() => {
    if (!fullPage) return;
    const root = document.documentElement;
    root.style.setProperty("--site-header-height", "0px");
    root.setAttribute("data-apt-full-page", "true");
    return () => {
      root.style.removeProperty("--site-header-height");
      root.removeAttribute("data-apt-full-page");
    };
  }, [fullPage]);

  if (immersive) return <div className="min-w-0 overflow-hidden" style={{ height: "100dvh" }}>{children}</div>;

  if (fullPage) {
    return (
      <div className="flex min-h-dvh min-w-0 flex-col bg-[var(--lab-bg,#f8fafc)]">
        {/* No SiteHeader / desktop sidebar / mobile global nav */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        <SiteFooter />
        {/* Mobile: leave room so the last content/footer isn't under the floating dock. */}
        <div aria-hidden className={MOBILE_DOCK_SPACER} />
        <MobileDock />
      </div>
    );
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <Link
          href="/"
          className="flex min-h-[92px] items-center border-b border-slate-100 px-5 py-1"
          aria-label="집랩 홈"
        >
          <BrandLogo priority />
        </Link>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="주요 메뉴">
          {NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`lab-side-link ${active ? "lab-side-link-active" : ""}`}
              >
                <Icon className="h-[18px] w-[18px]" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <p className="px-5 pb-5 text-[11px] leading-5 text-slate-400">
          국토교통부 실거래 기반
          <br />
          LAB Series · Real estate research
        </p>
      </aside>
      <div className="flex min-h-dvh min-w-0 flex-col lg:col-start-2">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
        {/* Mobile: leave room so the last content/footer isn't under the floating dock. */}
        <div aria-hidden className={MOBILE_DOCK_SPACER} />
        <MobileDock />
      </div>
    </div>
  );
}
