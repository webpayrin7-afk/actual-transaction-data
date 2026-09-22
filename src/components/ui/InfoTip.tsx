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
  rootClassName = "",
  trigger,
}: {
  "aria-label": string;
  children: ReactNode;
  className?: string;
  /** Extra classes on the outer span (e.g. tighter margin in dense meta rows). */
  rootClassName?: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const fineHoverRef = useRef(false);

  useEffect(() => {
    fineHoverRef.current = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;
  }, []);

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
          onMouseEnter={() => {
            if (fineHoverRef.current) setOpen(true);
          }}
          onMouseLeave={() => {
            if (fineHoverRef.current) setOpen(false);
          }}
        >
          {children}
        </div>,
        document.body,
      )
    ) : null;

  return (
    <span
      ref={rootRef}
      className={`relative z-10 inline-flex shrink-0 items-center self-center align-middle ${
        trigger || rootClassName ? "" : "ml-[0.35em]"
      } ${rootClassName}`.trim()}
      onMouseEnter={() => {
        if (fineHoverRef.current) setOpen(true);
      }}
      onMouseLeave={() => {
        if (fineHoverRef.current) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onFocus={() => {
          if (fineHoverRef.current) setOpen(true);
        }}
        onBlur={(event) => {
          if (!fineHoverRef.current) return;
          const next = event.relatedTarget as Node | null;
          if (panelRef.current?.contains(next)) return;
          if (buttonRef.current?.contains(next)) return;
          setOpen(false);
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          // Touch / non-hover: toggle. Fine pointer already opens on hover.
          if (!fineHoverRef.current) setOpen((value) => !value);
        }}
        className={`relative z-10 inline-flex cursor-pointer items-center justify-center text-[color:var(--lab-muted)] transition hover:text-[color:var(--lab-navy-950)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
          trigger ? "min-h-4 min-w-0" : "h-4 w-4"
        } ${className}`.trim()}
      >
        {/* Expand hit target to ≥44×44 without pushing the glyph away from the label */}
        <span
          aria-hidden
          className={
            trigger
              ? "pointer-events-auto absolute -inset-y-3.5 inset-x-0"
              : "pointer-events-auto absolute -inset-x-3.5 -inset-y-3.5"
          }
        />
        {trigger ?? (
          <svg
            viewBox="0 0 16 16"
            className="pointer-events-none relative z-10 block h-4 w-4"
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
