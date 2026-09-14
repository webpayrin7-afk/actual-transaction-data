"use client";

import type { ReactNode } from "react";
import { labPrimaryTabClass } from "@/components/ui/lab";

export type LabTabItem<T extends string = string> = {
  id: T;
  label: string;
};

type LabTabsProps<T extends string> = {
  items: readonly LabTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the tablist. */
  ariaLabel: string;
  className?: string;
  /** Optional trailing content (rare). */
  trailing?: ReactNode;
  /**
   * Compact = calculator density (slightly lower height / padding, no icons).
   * Same LAB shell as region detail tabs.
   */
  density?: "default" | "compact";
};

/**
 * LAB Series SubTabs — shared rounded shell, soft teal active surface.
 * Matches region detail (시장 현황 | 실거래 검색 | 단지 탐색).
 * No underline, no separate pill borders, no solid teal fill.
 */
export function LabTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = "",
  trailing,
  density = "default",
}: LabTabsProps<T>) {
  const compact = density === "compact";
  return (
    <div
      className={`inline-flex w-full gap-1 rounded-xl border border-slate-200 bg-white p-1 ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={labPrimaryTabClass(
              active,
              compact
                ? "min-h-11 flex-1 px-2.5 text-[13px] sm:flex-none"
                : "min-h-11 flex-1 px-3.5 sm:flex-none",
            )}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}
