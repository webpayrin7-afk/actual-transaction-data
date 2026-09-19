"use client";

import { useId, useState, type ReactNode } from "react";

type LabDisclosureProps = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled open state. When set with onOpenChange, becomes controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  titleClassName?: string;
};

/**
 * LAB Series compact disclosure.
 * Quiet in the default view; clear when the user needs detail.
 * Uses divider + typography — not nested cards or teal CTAs.
 */
export function LabDisclosure({
  title,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className = "",
  titleClassName = "",
}: LabDisclosureProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  const buttonId = useId();
  const panelId = useId();

  function setOpen(next: boolean) {
    if (!controlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div className={`border-t border-slate-200 ${className}`.trim()}>
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left transition hover:text-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <span
          className={
            titleClassName
              ? `min-w-0 ${titleClassName}`
              : "min-w-0 text-sm font-semibold text-slate-900"
          }
        >
          {title}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={`h-[18px] w-[18px] shrink-0 text-slate-500 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 7.5 10 12.5 15 7.5" />
        </svg>
      </button>

      {open ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="border-t border-slate-100 pt-2.5"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
