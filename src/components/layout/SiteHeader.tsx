"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";
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

const DRAWER_CLOSE_MS = 160;

function navLinkClass(active: boolean) {
  return `whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition sm:px-2.5 sm:text-[0.9375rem] ${
    active
      ? "bg-teal-50 text-teal-800"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;
}

function sectionHeadingClass() {
  return "px-3 pb-1 text-[10px] font-bold tracking-[0.14em] text-slate-400 uppercase";
}

function drawerItemClass(active: boolean) {
  return `flex h-[50px] items-center rounded-md px-3 text-sm transition-colors ${
    active
      ? "bg-teal-50 font-medium text-teal-800"
      : "text-slate-700 hover:bg-teal-50/70 active:bg-teal-50/80"
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
  const touchStartXRef = useRef<number | null>(null);
  const menuId = useId();
  const titleId = useId();

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
    }, DRAWER_CLOSE_MS);
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

  function onDrawerTouchStart(event: ReactTouchEvent) {
    touchStartXRef.current = event.touches[0]?.clientX ?? null;
  }

  function onDrawerTouchEnd(event: ReactTouchEvent) {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    if (startX == null) return;
    const endX = event.changedTouches[0]?.clientX;
    if (endX == null) return;
    if (endX - startX > 72) closeMenu();
  }

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
                aria-label="더보기"
                onClick={openMenu}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-600 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900"
              >
                <Menu className="h-[18px] w-[18px]" aria-hidden />
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
            className={`fixed inset-0 z-[45] bg-black/12 transition-opacity ease-out ${
              menuShown
                ? "opacity-100 duration-[200ms]"
                : "opacity-0 duration-[160ms]"
            }`}
            aria-hidden
            onClick={closeMenu}
          />

          <div
            id={menuId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={`fixed inset-y-0 right-0 z-[48] flex w-[min(300px,85vw)] flex-col border-l border-slate-200 bg-white shadow-[-2px_0_8px_rgba(15,23,42,0.04)] transition-transform ease-out ${
              menuShown
                ? "translate-x-0 duration-[200ms]"
                : "translate-x-full duration-[160ms]"
            }`}
            onTouchStart={onDrawerTouchStart}
            onTouchEnd={onDrawerTouchEnd}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 pr-2 pl-4">
              <h2
                id={titleId}
                className="text-sm font-semibold text-slate-900"
              >
                더보기
              </h2>
              <button
                type="button"
                aria-label="닫기"
                onClick={closeMenu}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              >
                <X className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-3">
              <p className={sectionHeadingClass()}>도구</p>
              <nav aria-label="도구" className="flex flex-col">
                {TOOL_NAV.map((item) => {
                  const active = item.match(pathname);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={drawerItemClass(active)}
                      onClick={closeMenu}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>

              <div className="mt-3">
                <p className={sectionHeadingClass()}>서비스</p>
                <nav aria-label="서비스" className="flex flex-col">
                  {MORE_SERVICE_LINKS.map((item) => {
                    const active = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={closeMenu}
                        className={drawerItemClass(active)}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </header>
  );
}
