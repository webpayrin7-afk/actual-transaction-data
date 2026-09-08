"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";

/** Header utility — compact 단지 검색 진입 (기존 AptQuickSearch 재사용) */
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
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`.trim()}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label="단지 검색"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition ${
          open
            ? "bg-teal-50 text-teal-800"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <Search className="h-4 w-4" />
        <span className="hidden lg:inline">단지 검색</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="단지 검색"
          className="absolute top-full right-0 z-50 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-2.5 shadow-md shadow-slate-200/60"
        >
          <AptQuickSearch
            compact
            inputId="header-apt-search"
            placeholder="아파트 단지명 검색"
            emptySubmitHref="/complexes"
            showPrice={false}
          />
        </div>
      ) : null}
    </div>
  );
}
