import type { ReactNode } from "react";

export function LabKpiCard({
  label,
  value,
  hint,
  footer,
  className = "",
  valueClassName = "",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={`lab-card px-4 py-4 sm:px-5 ${className}`.trim()}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={`lab-kpi-value mt-1.5 text-2xl font-semibold leading-tight sm:text-[1.7rem] ${valueClassName}`.trim()}
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
