"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { INFO_PANEL_CLASS, placeInfoPanel } from "@/components/ui/info-panel";

/**
 * Site-common ⓘ tip.
 * Panel is portaled to document.body so transformed / overflow-clip ancestors
 * (apt-detail enter animation) cannot swallow taps or clip the panel.
 * Closes on outside click, panel body click, or Escape.
 */
export function InfoTip({
  "aria-label": ariaLabel,
  children,
  className = "",
  trigger,
}: {
  "aria-label": string;
  children: ReactNode;
  className?: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;

    function place() {
      if (!button || !panel) return;
      placeInfoPanel(button, panel);
    }

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const panel =
    open && typeof document !== "undefined" ? (
      createPortal(
        <div
          id={panelId}
          ref={panelRef}
          role="note"
          className={INFO_PANEL_CLASS}
        >
          {children}
        </div>,
        document.body,
      )
    ) : null;

  return (
    <span
      className={`relative z-10 inline-flex shrink-0 align-middle ${
        trigger ? "" : "ml-[0.25em]"
      }`}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={`relative z-10 inline-flex h-11 w-11 cursor-pointer items-center justify-center text-[color:var(--lab-muted)] transition hover:text-[color:var(--lab-navy-950)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${className}`.trim()}
      >
        {trigger ?? (
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none block h-4 w-4"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6.25"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            />
            <circle cx="8" cy="5.15" r="0.75" fill="currentColor" />
            <path
              d="M8 7.15v4.15"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
      {panel}
    </span>
  );
}
