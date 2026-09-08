"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import { toPyeong } from "@/lib/utils/format";

/** 표시용 — areaKey/API 값과 무관 */
export function formatAreaSelectLabel(sqm: number): string {
  const pyeong = Math.round(toPyeong(sqm));
  return `${sqm.toFixed(2)}㎡ (${pyeong}평)`;
}

type AptAreaSelectProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
};

/**
 * compact 전용면적 dropdown.
 * value/onChange는 기존 areaKey("all" | exclusiveArea key)를 그대로 사용.
 * visual: 조용한 filter — KPI보다 튀지 않게.
 */
export function AptAreaSelect({ areas, value, onChange }: AptAreaSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const sorted = useMemo(
    () => [...areas].sort((a, b) => a.exclusiveArea - b.exclusiveArea),
    [areas],
  );

  const selectedArea = useMemo(
    () => sorted.find((area) => area.key === value) ?? null,
    [sorted, value],
  );

  const triggerLabel =
    value === "all" || !selectedArea
      ? "전체 면적"
      : formatAreaSelectLabel(selectedArea.exclusiveArea);

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

  // 면적 1개: dropdown 없이 static
  if (sorted.length <= 1) {
    const only = sorted[0];
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="shrink-0 text-xs text-slate-500">전용면적</span>
        <span className="text-sm tabular-nums text-slate-800">
          {only ? formatAreaSelectLabel(only.exclusiveArea) : "전체 면적"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="shrink-0 text-xs text-slate-500">전용면적</span>
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label="전용면적 선택"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-transparent px-2 text-sm tabular-nums text-slate-800 hover:bg-slate-50 ${
            open ? "bg-slate-50" : ""
          }`}
        >
          <span>{triggerLabel}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 text-slate-400 transition ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden
          />
        </button>

        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="전용면적"
            className="absolute top-full left-0 z-40 mt-1 max-h-64 min-w-full w-max max-w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-slate-200 bg-white py-0.5 shadow-sm"
          >
            <li role="option" aria-selected={value === "all"}>
              <button
                type="button"
                className={`w-full px-2.5 py-1.5 text-left text-sm ${
                  value === "all"
                    ? "bg-slate-100 font-medium text-slate-900"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => {
                  onChange("all");
                  setOpen(false);
                }}
              >
                전체 면적
              </button>
            </li>
            {sorted.map((area) => {
              const active = area.key === value;
              return (
                <li key={area.key} role="option" aria-selected={active}>
                  <button
                    type="button"
                    className={`w-full px-2.5 py-1.5 text-left text-sm tabular-nums ${
                      active
                        ? "bg-slate-100 font-medium text-slate-900"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                    onClick={() => {
                      onChange(area.key);
                      setOpen(false);
                    }}
                  >
                    {formatAreaSelectLabel(area.exclusiveArea)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
