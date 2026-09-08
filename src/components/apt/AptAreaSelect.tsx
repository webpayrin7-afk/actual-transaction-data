"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import { toPyeong } from "@/lib/utils/format";

/** 표시용 — areaKey/API 값과 무관 */
export function formatAreaSelectLabel(sqm: number): string {
  const pyeong = Math.round(toPyeong(sqm));
  return `${sqm.toFixed(2)}㎡ · 약 ${pyeong}평`;
}

function areaParts(sqm: number) {
  return {
    sqm: `${sqm.toFixed(2)}㎡`,
    pyeong: `약 ${Math.round(toPyeong(sqm))}평`,
  };
}

type AptAreaSelectProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
};

function AreaValue({
  sqm,
  size = "md",
}: {
  sqm: number;
  size?: "md" | "sm";
}) {
  const parts = areaParts(sqm);
  const primary =
    size === "md"
      ? "text-[13px] font-semibold tabular-nums tracking-tight text-slate-900 sm:text-sm"
      : "text-[13px] font-semibold tabular-nums tracking-tight text-slate-900";
  const secondary =
    size === "md"
      ? "text-[11px] tabular-nums text-slate-500 sm:text-xs"
      : "text-[11px] tabular-nums text-slate-500";
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className={primary}>{parts.sqm}</span>
      <span className={secondary}>{parts.pyeong}</span>
    </span>
  );
}

/**
 * compact 전용면적 dropdown.
 * value/onChange는 기존 areaKey("all" | exclusiveArea key)를 그대로 사용.
 * visual refinement only — state/API 로직 변경 없음.
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
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-slate-500 sm:text-xs">
          전용면적
        </span>
        {only ? (
          <AreaValue sqm={only.exclusiveArea} />
        ) : (
          <span className="text-[13px] font-medium text-slate-800 sm:text-sm">
            전체 면적
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="shrink-0 text-[11px] font-medium tracking-wide text-slate-500 sm:text-xs">
        전용면적
      </span>
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label="전용면적 선택"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-8 min-w-[9.75rem] max-w-[min(100%,14rem)] items-center justify-between gap-2 rounded-md border bg-white px-2.5 transition sm:max-w-none ${
            open
              ? "border-slate-300 shadow-sm shadow-slate-200/50"
              : "border-slate-200/90 hover:border-slate-300 hover:bg-slate-50/80"
          }`}
        >
          <span className="min-w-0 truncate">
            {value === "all" || !selectedArea ? (
              <span className="text-[13px] font-medium text-slate-800 sm:text-sm">
                전체 면적
              </span>
            ) : (
              <AreaValue sqm={selectedArea.exclusiveArea} />
            )}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${
              open ? "rotate-180 text-slate-500" : ""
            }`}
            aria-hidden
          />
        </button>

        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="전용면적"
            className="absolute top-full left-0 z-40 mt-1 max-h-64 min-w-full w-max max-w-[min(18rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border border-slate-200/90 bg-white py-1 shadow-sm shadow-slate-200/70"
          >
            <li role="option" aria-selected={value === "all"}>
              <button
                type="button"
                className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left transition ${
                  value === "all"
                    ? "bg-slate-100/90 text-slate-900"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => {
                  onChange("all");
                  setOpen(false);
                }}
              >
                <span className="text-[13px] font-medium sm:text-sm">
                  전체 면적
                </span>
                {value === "all" ? (
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-teal-700"
                    aria-hidden
                  />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
              </button>
            </li>

            <li className="my-1 border-t border-slate-100" aria-hidden />

            {sorted.map((area) => {
              const active = area.key === value;
              const parts = areaParts(area.exclusiveArea);
              return (
                <li key={area.key} role="option" aria-selected={active}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-3 px-2.5 py-1.5 text-left transition ${
                      active
                        ? "bg-slate-100/90"
                        : "hover:bg-slate-50"
                    }`}
                    onClick={() => {
                      onChange(area.key);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold tabular-nums tracking-tight text-slate-900 sm:text-sm">
                        {parts.sqm}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-slate-500 sm:text-xs">
                        {parts.pyeong}
                      </span>
                    </span>
                    {active ? (
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-teal-700"
                        aria-hidden
                      />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
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
