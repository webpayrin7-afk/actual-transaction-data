"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { StatsScope } from "@/lib/market/keys";
import {
  enabledStatsRegions,
  statsRegionLabel,
} from "@/lib/market/region-scope";

/**
 * compact 시·도 dropdown.
 * 추후 옆에 시·군·구 filter를 붙일 수 있도록 단독 filter 크기로 유지.
 */
export function StatsRegionSelect({
  value,
  onChange,
}: {
  value: StatsScope;
  onChange: (v: StatsScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const options = enabledStatsRegions();

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
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 min-w-[4.75rem] items-center justify-between gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-800 hover:bg-slate-50 sm:text-[13px]"
      >
        <span className="truncate">{statsRegionLabel(value)}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="지역 선택"
          className="absolute top-full right-0 z-40 mt-1 max-h-64 min-w-[8.5rem] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-md shadow-slate-200/60"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`flex w-full px-3 py-2 text-left text-sm transition ${
                    active
                      ? "bg-teal-50 font-medium text-teal-900"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                  onClick={() => {
                    onChange(opt.value as StatsScope);
                    setOpen(false);
                  }}
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
