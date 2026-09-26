"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { SiteHeaderLoadProgress } from "@/components/layout/LoadProgress";
import { JipLabLogo } from "@/components/brand/JipLabLogo";
import { HeaderAptSearch } from "@/components/layout/HeaderAptSearch";
import { SiteMenuButton } from "@/components/layout/SiteMenu";
import { PRIMARY_NAV } from "@/lib/nav/site-menu";

/** 하단 메뉴 첫 페이지 — 모바일 상단바 가운데 제목 (본문 제목 줄 대신) */
const HEADER_TITLES: Record<string, string> = {
  "/": "지도",
  "/market": "시장 정보",
  "/map": "지도",
  "/regions": "지역 조회",
  "/complexes": "단지 조회",
  "/presale": "분양 정보",
};

function navLinkClass(active: boolean) {
  return `whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition sm:px-2.5 sm:text-[0.9375rem] ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;
}

/**
 * 전역 상단바. `className` 으로 화면별로 숨길 수 있다 — 지도 첫 화면은 모바일에서 숨기고
 * 같은 검색·메뉴를 지도 조작 줄에 둔다 (MapSearchPage). 높이는 --site-header-height 로 알린다 (숨으면 0).
 */
export function SiteHeader({ className = "" }: { className?: string } = {}) {
  const pathname = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  const headerTitle = HEADER_TITLES[pathname] ?? null;

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const sync = () => {
      // 숨긴 상단바(display:none)는 0 — 지도가 화면 전체를 쓴다
      const h = Math.max(0, Math.round(el.getBoundingClientRect().height));
      document.documentElement.style.setProperty("--site-header-height", `${h}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      document.documentElement.style.removeProperty("--site-header-height");
    };
  }, []);

  return (
    <header
      ref={headerRef}
      data-site-header
      className={`sticky top-0 z-50 bg-white shadow-none ${className}`.trim()}
    >
      <div className="mx-auto w-full max-w-7xl px-3 sm:pr-4 sm:pl-1 lg:pr-6 lg:pl-2">
        <div className="relative flex py-1.5 sm:h-14 sm:flex-row sm:items-center sm:gap-4 sm:py-0">
          {headerTitle ? (
            <p
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center whitespace-nowrap text-[17px] font-bold leading-6 tracking-tight text-[color:var(--lab-navy-950)] sm:hidden"
            >
              {headerTitle}
            </p>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-5">
            <Link
              href="/"
              className="inline-flex shrink-0 items-center lg:hidden"
              aria-label="집랩 홈"
            >
              <JipLabLogo priority />
            </Link>

            <nav
              className="ml-auto hidden min-w-0 items-center gap-0.5 sm:flex lg:ml-0"
              aria-label="주요 메뉴"
            >
              {PRIMARY_NAV.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={navLinkClass(active)}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-0.5 lg:ml-0">
              <HeaderAptSearch />

              <SiteMenuButton />
            </div>
          </div>
        </div>
      </div>
      <SiteHeaderLoadProgress />
    </header>
  );
}
