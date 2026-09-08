"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Building2, ChevronDown } from "lucide-react";

const PRIMARY_NAV = [
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

const TOOL_NAV = [
  {
    href: "/school",
    label: "학군 정보",
    description: "단지·지역 주변 학군 살펴보기",
    match: (pathname: string) => pathname.startsWith("/school"),
  },
  {
    href: "/loan",
    label: "대출계산기",
    description: "LTV·DSR·DTI 대출 한도 계산",
    match: (pathname: string) => pathname.startsWith("/loan"),
  },
  {
    href: "/rates",
    label: "금리비교",
    description: "은행별 대출·보전 금리 비교",
    match: (pathname: string) => pathname.startsWith("/rates"),
  },
] as const;

function navClass(active: boolean) {
  return `whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition sm:px-2.5 sm:text-[0.9375rem] ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [navPath, setNavPath] = useState(pathname);
  const toolsRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const toolsActive = TOOL_NAV.some((item) => item.match(pathname));

  if (navPath !== pathname) {
    setNavPath(pathname);
    if (toolsOpen) setToolsOpen(false);
  }

  useEffect(() => {
    if (!toolsOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!toolsRef.current?.contains(event.target as Node)) {
        setToolsOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setToolsOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [toolsOpen]);

  return (
    <header
      data-site-header
      className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur"
    >
      <div className="mx-auto w-full max-w-7xl px-3 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1 py-2 sm:h-14 sm:flex-row sm:items-center sm:gap-5 sm:py-0">
          <div className="flex min-w-0 items-center gap-2 sm:gap-5">
            <Link href="/" className="inline-flex shrink-0 items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-600 text-white sm:h-8 sm:w-8 sm:rounded-lg">
                <Building2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              </span>
              <span className="text-[0.9375rem] font-semibold tracking-tight text-slate-900 sm:text-base">
                아파트 데이터랩
              </span>
            </Link>

            <nav
              className="ml-auto hidden min-w-0 items-center gap-0.5 sm:flex"
              aria-label="주요 메뉴"
            >
              {PRIMARY_NAV.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={navClass(active)}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="ml-auto flex shrink-0 items-center sm:ml-0">
              <div className="relative shrink-0" ref={toolsRef}>
                <button
                  type="button"
                  aria-expanded={toolsOpen}
                  aria-controls={menuId}
                  aria-haspopup="menu"
                  onClick={() => setToolsOpen((open) => !open)}
                  className={`inline-flex items-center gap-0.5 ${navClass(toolsActive || toolsOpen)}`}
                >
                  도구
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition ${toolsOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {toolsOpen ? (
                  <div
                    id={menuId}
                    role="menu"
                    className="absolute top-full right-0 z-50 mt-1.5 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-md shadow-slate-200/60"
                  >
                    {TOOL_NAV.map((item) => {
                      const active = item.match(pathname);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          role="menuitem"
                          className={`block rounded-lg px-3 py-2.5 transition ${
                            active
                              ? "bg-teal-50 text-teal-900"
                              : "text-slate-800 hover:bg-slate-50"
                          }`}
                        >
                          <span className="block text-sm font-medium">
                            {item.label}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">
                            {item.description}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* 모바일: PC와 동일한 primary 메뉴를 두 번째 줄에 항상 노출 (햄버거 없음) */}
          <nav
            className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 pb-0.5 sm:hidden"
            aria-label="주요 메뉴"
          >
            {PRIMARY_NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className={navClass(active)}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}
