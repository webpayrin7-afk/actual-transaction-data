"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SiteHeaderLoadProgress } from "@/components/layout/LoadProgress";
import { BrandLogo } from "@/components/layout/BrandLogo";
import { HeaderAptSearch } from "@/components/layout/HeaderAptSearch";
import {
  MENU_INFO_LINKS,
  PRIMARY_NAV,
  TOOL_NAV,
} from "@/lib/nav/site-menu";

function menuItemClass(active: boolean) {
  return `block rounded-lg px-3 py-2.5 text-sm font-medium transition ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-700 hover:bg-slate-50 hover:text-slate-900"
  }`;
}

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navPath, setNavPath] = useState(pathname);
  const menuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const menuId = useId();

  if (navPath !== pathname) {
    setNavPath(pathname);
    if (menuOpen) setMenuOpen(false);
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
    if (!menuOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const mq = window.matchMedia("(max-width: 767px)");
    const prev = document.body.style.overflow;
    if (mq.matches) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  return (
    <header
      ref={headerRef}
      data-site-header
      className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur"
    >
      <div className="mx-auto w-full max-w-7xl pr-2 pl-0 sm:pr-4 sm:pl-1 lg:pr-6 lg:pl-2">
        <div className="flex h-12 items-center gap-2 sm:h-14 sm:gap-3">
          <Link
            href="/"
            className="-ml-1 inline-flex shrink-0 items-center gap-2 lg:hidden sm:-ml-1.5"
          >
            <BrandLogo compact priority />
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <HeaderAptSearch />

            <div className="relative" ref={menuRef}>
              <button
                type="button"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                aria-haspopup="dialog"
                aria-label={menuOpen ? "전체 메뉴 닫기" : "전체 메뉴 열기"}
                onClick={() => setMenuOpen((open) => !open)}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition ${
                  menuOpen
                    ? "bg-teal-50 text-teal-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {menuOpen ? (
                  <X className="h-[18px] w-[18px]" />
                ) : (
                  <Menu className="h-[18px] w-[18px]" />
                )}
              </button>

              {menuOpen ? (
                <>
                  <div
                    className="fixed inset-0 z-[55] bg-slate-900/25 md:hidden"
                    aria-hidden
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    id={menuId}
                    role="dialog"
                    aria-label="전체 메뉴"
                    className="fixed inset-x-0 top-[var(--site-header-height,3rem)] z-[60] max-h-[min(70vh,calc(100dvh-var(--site-header-height,3rem)))] overflow-y-auto border-b border-slate-200 bg-white p-3 md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-1.5 md:max-h-[min(70vh,32rem)] md:w-72 md:rounded-xl md:border md:border-slate-200 md:p-2"
                  >
                    <nav aria-label="전체 메뉴" className="flex flex-col gap-0.5">
                      {PRIMARY_NAV.map((item) => {
                        const active = item.match(pathname);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={menuItemClass(active)}
                            onClick={() => setMenuOpen(false)}
                          >
                            {item.label}
                          </Link>
                        );
                      })}

                      <div className="my-2 border-t border-slate-100" />

                      {TOOL_NAV.map((item) => {
                        const active = item.match(pathname);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={menuItemClass(active)}
                            onClick={() => setMenuOpen(false)}
                          >
                            {item.label}
                          </Link>
                        );
                      })}
                    </nav>

                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <p className="px-3 pb-1.5 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase">
                        서비스 · 정책
                      </p>
                      <div className="flex flex-col gap-0.5">
                        {MENU_INFO_LINKS.map((item) => {
                          const active = pathname === item.href;
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              onClick={() => setMenuOpen(false)}
                              className={`rounded-md px-3 py-1.5 text-xs transition ${
                                active
                                  ? "bg-teal-50 text-teal-800"
                                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                              }`}
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
            </div>
          </div>
        </div>
      </div>
      <SiteHeaderLoadProgress />
    </header>
  );
}
