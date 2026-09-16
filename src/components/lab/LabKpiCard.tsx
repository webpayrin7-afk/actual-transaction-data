import type { ReactNode } from "react";

export function LabKpiCard({
  label,
  value,
  hint,
  footer,
  className = "",
  valueClassName = "",
  flat = false,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
  className?: string;
  valueClassName?: string;
  /** Lighter card: weaker border, no shadow, tighter padding. */
  flat?: boolean;
}) {
  return (
    <div
      className={
        flat
          ? `rounded-xl border border-slate-200/70 bg-white px-3.5 py-3 sm:px-4 sm:py-3.5 ${className}`.trim()
          : `lab-card px-4 py-4 sm:px-5 ${className}`.trim()
      }
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={`lab-kpi-value mt-1.5 text-2xl font-semibold leading-tight sm:text-[1.65rem] ${valueClassName}`.trim()}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[11px] leading-4 text-slate-500">{hint}</p>
      ) : null}
      {footer}
    </div>
  );
}
