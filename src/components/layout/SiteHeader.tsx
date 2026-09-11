"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SiteHeaderLoadProgress } from "@/components/layout/LoadProgress";
import { BrandLogo } from "@/components/layout/BrandLogo";
import { HeaderAptSearch } from "@/components/layout/HeaderAptSearch";
import {
  MORE_SERVICE_LINKS,
  PRIMARY_NAV,
  TOOL_NAV,
} from "@/lib/nav/site-menu";

const MENU_EXIT_MS = 160;

function navLinkClass(active: boolean) {
  return `whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition sm:px-2.5 sm:text-[0.9375rem] ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;
}

function sectionHeadingClass() {
  return "px-2.5 pb-0.5 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase";
}

/** 도구 — primary utility */
function toolItemClass(active: boolean) {
  return `block rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-800 hover:bg-teal-50/70 active:bg-teal-50/80"
  }`;
}

/** 서비스 — secondary (same size, softer color) */
function serviceItemClass(active: boolean) {
  return `block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-teal-50/70 active:bg-teal-50/80"
  }`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuShown, setMenuShown] = useState(false);
  const [navPath, setNavPath] = useState(pathname);
  const headerRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const menuId = useId();

  function clearCloseTimer() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openMenu() {
    clearCloseTimer();
    setMenuOpen(true);
    setMenuMounted(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setMenuShown(true));
    });
  }

  function closeMenu() {
    setMenuOpen(false);
    setMenuShown(false);
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setMenuMounted(false);
      closeTimerRef.current = null;
    }, MENU_EXIT_MS);
  }

  function toggleMenu() {
    if (menuOpen) closeMenu();
    else openMenu();
  }

  if (navPath !== pathname) {
    setNavPath(pathname);
    if (menuOpen || menuMounted) {
      setMenuOpen(false);
      setMenuShown(false);
      setMenuMounted(false);
    }
  }

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const sync = () => {
      const h = Math.max(1, Math.round(el.getBoundingClientRect().height));
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

  useEffect(() => {
    if (!menuMounted) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuMounted]);

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <header
      ref={headerRef}
      data-site-header
      className="sticky top-0 z-50 border-b border-slate-200/80 bg-white"
    >
      <div className="mx-auto w-full max-w-7xl pr-2 pl-0 sm:pr-4 sm:pl-1 lg:pr-6 lg:pl-2">
        <div className="flex flex-col gap-0.5 py-1 sm:h-14 sm:flex-row sm:items-center sm:gap-4 sm:py-0">
          <div className="flex min-w-0 items-center gap-2 sm:gap-5">
            <Link
              href="/"
              className="-ml-1 inline-flex shrink-0 items-center gap-2 lg:hidden sm:-ml-1.5"
            >
              <BrandLogo compact priority />
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

            <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:ml-0">
              <HeaderAptSearch />

              <button
                type="button"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                aria-haspopup="dialog"
                aria-label={menuOpen ? "더보기 닫기" : "더보기"}
                onClick={toggleMenu}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-150 ${
                  menuOpen
                    ? "text-teal-800 hover:bg-teal-50/70"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span className="relative inline-flex h-[18px] w-[18px]">
                  <Menu
                    className={`absolute inset-0 h-[18px] w-[18px] transition duration-200 ease-out ${
                      menuOpen ? "rotate-90 opacity-0" : "rotate-0 opacity-100"
                    }`}
                    aria-hidden
                  />
                  <X
                    className={`absolute inset-0 h-[18px] w-[18px] transition duration-200 ease-out ${
                      menuOpen ? "rotate-0 opacity-100" : "-rotate-90 opacity-0"
                    }`}
                    aria-hidden
                  />
                </span>
              </button>
            </div>
          </div>

          <nav
            className="ml-1.5 flex items-center gap-0.5 overflow-x-auto px-1 pb-0.5 sm:hidden"
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
        </div>
      </div>
      <SiteHeaderLoadProgress />

      {menuMounted ? (
        <>
          <div
            className={`fixed inset-x-0 bottom-0 z-[45] bg-black/15 transition-opacity ease-out md:bg-black/10 ${
              menuShown
                ? "opacity-100 duration-[200ms]"
                : "opacity-0 duration-[160ms]"
            }`}
            style={{ top: "var(--site-header-height, 3.5rem)" }}
            aria-hidden
            onClick={closeMenu}
          />

          {/* compact dropdown card — 햄버거 우측 정렬, 모바일도 full-width 아님 */}
          <div
            id={menuId}
            role="dialog"
            aria-label="더보기"
            className={`fixed right-3 z-[48] w-[calc(100%-1.5rem)] max-w-[22.5rem] origin-top rounded-xl border border-slate-200 bg-white px-1.5 py-1.5 shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition ease-out sm:right-4 md:right-2 md:w-72 lg:right-[max(0.5rem,calc((100vw-80rem)/2+0.5rem))] ${
              menuShown
                ? "translate-y-0 opacity-100 duration-[200ms]"
                : "-translate-y-2 opacity-0 duration-[160ms]"
            }`}
            style={{ top: "calc(var(--site-header-height, 3.5rem) + 0.35rem)" }}
          >
            <p className={sectionHeadingClass()}>도구</p>
            <nav aria-label="도구" className="flex flex-col">
              {TOOL_NAV.map((item) => {
                const active = item.match(pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={toolItemClass(active)}
                    onClick={closeMenu}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-1 border-t border-slate-100 pt-1">
              <p className={sectionHeadingClass()}>서비스</p>
              <div className="flex flex-col">
                {MORE_SERVICE_LINKS.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeMenu}
                      className={serviceItemClass(active)}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </header>
  );
}
