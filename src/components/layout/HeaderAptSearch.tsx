"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { UNIFIED_SEARCH_PLACEHOLDER } from "@/lib/nav/site-menu";

/** Header utility — 통합(단지+지역) 검색. 모바일은 sheet, PC는 dropdown */
export function HeaderAptSearch({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
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
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label="통합 검색"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-md transition ${
          open
            ? "bg-teal-50 text-teal-800"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <Search className="h-[18px] w-[18px]" />
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-[60] bg-slate-900/30 md:hidden"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div
            id={panelId}
            role="dialog"
            aria-label="통합 검색"
            className="fixed inset-x-0 top-0 z-[70] border-b border-slate-200 bg-white p-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:absolute md:inset-x-auto md:top-full md:right-0 md:mt-1.5 md:w-[min(24rem,calc(100vw-2rem))] md:rounded-xl md:border md:border-slate-200 md:p-2.5 md:pt-2.5"
          >
            <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
              <p className="text-sm font-semibold text-slate-900">통합 검색</p>
              <button
                type="button"
                aria-label="통합 검색 닫기"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <AptQuickSearch
              compact
              autoFocus={open}
              inputId="header-unified-search"
              placeholder={UNIFIED_SEARCH_PLACEHOLDER}
              showPrice={false}
              includeRegions
              onNavigate={() => setOpen(false)}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
