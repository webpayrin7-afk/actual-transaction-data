"use client";

import type { ReactNode } from "react";
import { labUnderlineTabClass } from "@/components/ui/lab";

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
};

/**
 * LAB Series plain-text tabs: active teal text + underline.
 * No pills, no segmented boxes, no shadows.
 */
export function LabTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = "",
  trailing,
}: LabTabsProps<T>) {
  return (
    <div
      className={`flex w-full items-stretch gap-0 border-b border-slate-200 ${className}`.trim()}
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
            className={labUnderlineTabClass(
              active,
              "min-h-11 flex-1 px-2 text-sm",
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
