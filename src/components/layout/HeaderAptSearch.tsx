"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { UNIFIED_SEARCH_PLACEHOLDER } from "@/lib/nav/site-menu";

const EXIT_MS = 160;

/** Header utility — 통합(단지+지역) 검색. 모바일은 sheet, PC는 dropdown */
export function HeaderAptSearch({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelId = useId();

  function clearCloseTimer() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openSearch() {
    clearCloseTimer();
    setOpen(true);
    setMounted(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setShown(true));
    });
  }

  function closeSearch() {
    setOpen(false);
    setShown(false);
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      closeTimerRef.current = null;
    }, EXIT_MS);
  }

  function toggleSearch() {
    if (open) closeSearch();
    else openSearch();
  }

  useEffect(() => {
    if (!mounted) return;

    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) closeSearch();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeSearch();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);

    const mq = window.matchMedia("(max-width: 767px)");
    const prev = document.body.style.overflow;
    if (mq.matches) document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
    // closeSearch closes via latest timers/state; mount gates listeners
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label="통합 검색"
        onClick={toggleSearch}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-150 ${
          open
            ? "text-teal-800 hover:bg-teal-50/70"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <Search className="h-[18px] w-[18px]" />
      </button>

      {mounted ? (
        <>
          <div
            className={`fixed inset-0 z-[60] bg-slate-900/25 transition-opacity ease-out md:hidden ${
              shown
                ? "opacity-100 duration-[200ms]"
                : "opacity-0 duration-[160ms]"
            }`}
            aria-hidden
            onClick={closeSearch}
          />
          <div
            id={panelId}
            role="dialog"
            aria-label="통합 검색"
            className={`fixed inset-x-0 top-0 z-[70] origin-top border-b border-slate-200 bg-white p-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition ease-out md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-1.5 md:w-[min(24rem,calc(100vw-2rem))] md:rounded-xl md:border md:border-slate-200 md:p-2.5 md:pt-2.5 md:shadow-[0_8px_20px_rgba(15,23,42,0.06)] ${
              shown
                ? "translate-y-0 opacity-100 duration-[200ms]"
                : "-translate-y-2 opacity-0 duration-[160ms]"
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
              <p className="text-sm font-semibold text-slate-900">통합 검색</p>
              <button
                type="button"
                aria-label="통합 검색 닫기"
                onClick={closeSearch}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <AptQuickSearch
              compact
              autoFocus={shown}
              inputId="header-unified-search"
              placeholder={UNIFIED_SEARCH_PLACEHOLDER}
              showPrice={false}
              includeRegions
              onNavigate={closeSearch}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
