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
    label: "시장동향",
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
  return `whitespace-nowrap rounded-lg px-2 py-1.5 font-medium transition sm:px-2.5 ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [toolsOpenPath, setToolsOpenPath] = useState<string | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const toolsActive = TOOL_NAV.some((item) => item.match(pathname));
  const toolsOpen = toolsOpenPath === pathname;

  useEffect(() => {
    if (!toolsOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!toolsRef.current?.contains(event.target as Node)) {
        setToolsOpenPath(null);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setToolsOpenPath(null);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [toolsOpen]);

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="relative mx-auto flex w-full max-w-7xl flex-col px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center">
          <Link href="/" className="inline-flex shrink-0 items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white">
              <Building2 className="h-4 w-4" />
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              아파트 데이터랩
            </span>
          </Link>
        </div>

        <nav
          className="-mx-1 flex items-center gap-0.5 pb-2.5 text-sm sm:gap-1"
          aria-label="주요 메뉴"
        >
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-1">
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
          </div>

          <div className="relative shrink-0" ref={toolsRef}>
            <button
              type="button"
              aria-expanded={toolsOpen}
              aria-controls={menuId}
              aria-haspopup="menu"
              onClick={() =>
                setToolsOpenPath((prev) => (prev === pathname ? null : pathname))
              }
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
                className="absolute top-full right-0 z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg shadow-slate-200/70"
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
        </nav>
      </div>
    </header>
  );
}
