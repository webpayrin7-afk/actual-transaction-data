"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";

export type FilterOption = { id: string; label: string };
export type FilterDef = {
  key: string;
  /** 칩·시트 제목 (예: "지역") */
  title: string;
  options: readonly FilterOption[];
  value: string;
  /** 아무것도 고르지 않은 상태 (칩에 제목을 보인다) */
  defaultId: string;
  onChange: (id: string) => void;
  /** 선택지가 많으면 격자로 (지역 18개) */
  grid?: boolean;
};

const CHIP =
  "relative inline-flex h-9 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-3 text-[14px] leading-5 before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";
const CHIP_ON =
  "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]";
const CHIP_OFF = "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] font-medium text-[color:var(--lab-navy-950)]";

/**
 * 조건 칩 한 줄 (분양 · 단지 조회 등)(지도 조건 칩과 같은 모양). 누르면 바텀시트에서 하나를 고른다.
 * 기본값이면 제목(지역·공급·면적·분양가), 골랐으면 고른 값이 칩에 보인다.
 */
export function LabFilterChips({ filters, ariaLabel = "조건" }: { filters: FilterDef[]; ariaLabel?: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = filters.find((f) => f.key === openKey) ?? null;

  return (
    <>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto overflow-y-hidden px-4 py-1 sm:mx-0 sm:px-0" role="group" aria-label={ariaLabel}>
        {filters.map((f) => {
          const on = f.value !== f.defaultId;
          const label = on ? f.options.find((o) => o.id === f.value)?.label ?? f.title : f.title;
          return (
            <button
              key={f.key}
              type="button"
              aria-haspopup="dialog"
              onClick={() => setOpenKey(f.key)}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
            >
              {label}
              <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
            </button>
          );
        })}
      </div>

      <LabBottomSheet open={open != null} onClose={() => setOpenKey(null)} title={open?.title ?? ""} hideDone>
        {open ? (
          open.grid ? (
            <div className="grid grid-cols-3 gap-2 pb-2 sm:grid-cols-6">
              {open.options.map((o) => {
                const active = o.id === open.value;
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      open.onChange(o.id);
                      setOpenKey(null);
                    }}
                    className={`min-h-11 rounded-lg border text-[15px] leading-5 ${
                      active
                        ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
                        : "border-[color:var(--lab-border)] bg-white font-medium text-[color:var(--lab-navy-950)]"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <ul className={`${LAB_LIST} pb-2`}>
              {open.options.map((o) => (
                <LabListRow
                  key={o.id}
                  title={o.label}
                  selected={o.id === open.value}
                  onClick={() => {
                    open.onChange(o.id);
                    setOpenKey(null);
                  }}
                />
              ))}
            </ul>
          )
        ) : null}
      </LabBottomSheet>
    </>
  );
}
