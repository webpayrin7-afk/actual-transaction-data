"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LAB_INPUT, LAB_TAB } from "@/components/ui/lab";

/** LAB 입력 — globals `.lab-input` + 패딩/타이포 */
export const inputClass = `${LAB_INPUT} px-3 text-sm outline-none placeholder:text-slate-400`;

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const hintId = id && hint ? `${id}-hint` : undefined;
  const errorId = id && error ? `${id}-error` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {id ? (
        <label
          htmlFor={id}
          className="text-xs font-medium text-[color:var(--lab-muted)]"
        >
          {label}
        </label>
      ) : (
        <p className="text-xs font-medium text-[color:var(--lab-muted)]">
          {label}
        </p>
      )}
      {hint ? (
        <p id={hintId} className="text-[11px] leading-4 text-slate-400">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 선택형 control — selected = light teal + dark teal */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  labelledBy,
  columns = 2,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  labelledBy?: string;
  columns?: 2 | 3;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className={`grid gap-2 sm:flex sm:flex-wrap ${
        columns === 3 ? "grid-cols-3" : "grid-cols-2"
      }`}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={`min-h-10 min-w-0 rounded-[10px] px-3 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
              active
                ? "border border-[color:var(--lab-teal-600)]/35 bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
                : "border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-900)] hover:bg-slate-50"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 연수 등 compact chip — Segmented와 동일 selected 톤 */
export function ChoiceChip({
  selected,
  onClick,
  children,
  ...rest
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] px-3 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
        selected
          ? "border border-[color:var(--lab-teal-600)]/35 bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
          : "border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-900)] hover:bg-slate-50"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ModeTabButton({
  selected,
  children,
  ...rest
}: {
  selected: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      className={`${LAB_TAB} min-w-0 flex-1 px-1 text-[11px] leading-tight sm:px-3 sm:text-sm ${
        selected ? "lab-tab-active" : ""
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
