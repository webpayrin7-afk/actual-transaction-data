"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { INFO_PANEL_CLASS, placeInfoPanel } from "@/components/ui/info-panel";

/**
 * Site-common icon-only ⓘ tip.
 * Panel is fixed, centered on the trigger, and clamped to the viewport.
 * Closes on outside click, panel body click, or Escape.
 */
export function InfoTip({
  "aria-label": ariaLabel,
  children,
  className = "",
}: {
  "aria-label": string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (buttonRef.current?.contains(event.target as Node)) return;
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

  return (
    <span className="inline-flex shrink-0 align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex cursor-pointer items-center justify-center text-[12px] leading-none text-slate-400 transition hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${className}`.trim()}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="note"
          className={INFO_PANEL_CLASS}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
