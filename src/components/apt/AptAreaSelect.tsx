"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import { toPyeong } from "@/lib/utils/format";

/** 표시용 — areaKey/API 값과 무관 */
export function formatAreaSelectLabel(sqm: number): string {
  const pyeong = Math.round(toPyeong(sqm));
  return `${sqm.toFixed(2)}㎡ · 약 ${pyeong}평`;
}

type AptAreaSelectProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
};

/**
 * compact 전용면적 dropdown.
 * value/onChange는 기존 areaKey("all" | exclusiveArea key)를 그대로 사용.
 */
export function AptAreaSelect({ areas, value, onChange }: AptAreaSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const sorted = useMemo(
    () => [...areas].sort((a, b) => a.exclusiveArea - b.exclusiveArea),
    [areas],
  );

  const options = useMemo(
    () => [
      { key: "all", label: "전체 면적" },
      ...sorted.map((area) => ({
        key: area.key,
        label: formatAreaSelectLabel(area.exclusiveArea),
      })),
    ],
    [sorted],
  );

  const selected =
    options.find((opt) => opt.key === value) ?? options[0] ?? {
      key: "all",
      label: "전체 면적",
    };

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

  // 면적 1개: dropdown 없이 static (전체/단일은 동일 데이터)
  if (sorted.length <= 1) {
    const only = sorted[0];
    const label = only
      ? formatAreaSelectLabel(only.exclusiveArea)
      : "전체 면적";
    return (
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2.5">
        <span className="shrink-0 text-xs font-medium text-slate-500">
          전용면적
        </span>
        <p className="text-sm font-medium tabular-nums text-slate-800">
          {label}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2.5">
      <span className="shrink-0 text-xs font-medium text-slate-500">
        전용면적
      </span>
      <div ref={rootRef} className="relative w-full max-w-[16.5rem] sm:w-auto">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label="전용면적 선택"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-full min-w-[11rem] items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium tabular-nums text-slate-800 hover:bg-slate-50 sm:w-auto"
        >
          <span className="truncate">{selected.label}</span>
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
            aria-label="전용면적"
            className="absolute top-full left-0 z-40 mt-1 max-h-64 w-full min-w-[11rem] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-md shadow-slate-200/60 sm:w-max sm:min-w-full"
          >
            {options.map((opt) => {
              const active = opt.key === value;
              return (
                <li key={opt.key} role="option" aria-selected={active}>
                  <button
                    type="button"
                    className={`flex w-full px-3 py-2 text-left text-sm tabular-nums transition ${
                      active
                        ? "bg-teal-50 font-medium text-teal-900"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                    onClick={() => {
                      onChange(opt.key);
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
    </div>
  );
}
