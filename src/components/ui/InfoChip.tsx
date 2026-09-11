"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

const PANEL_WIDTH = 320;
const VIEWPORT_PAD = 8;

export function InfoChip({
  label,
  "aria-label": ariaLabel,
  children,
}: {
  label: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
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
      const rect = button.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_PAD * 2);
      let left = rect.left;
      if (left + width > window.innerWidth - VIEWPORT_PAD) {
        left = Math.max(VIEWPORT_PAD, window.innerWidth - VIEWPORT_PAD - width);
      }
      if (left < VIEWPORT_PAD) left = VIEWPORT_PAD;
      panel.style.width = `${width}px`;
      panel.style.left = `${left}px`;
      panel.style.top = `${rect.bottom + 6}px`;
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
    <span ref={rootRef} className="relative inline-flex shrink-0 align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel ?? `${label} 안내`}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex cursor-pointer items-center gap-0.5 whitespace-nowrap rounded-full border border-slate-200/90 bg-slate-50 px-2 py-[3px] text-[11px] font-medium leading-none text-slate-500 transition hover:border-slate-300 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        {label}
        <span className="text-[10px] font-normal text-slate-400" aria-hidden="true">
          ⓘ
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="note"
          className="fixed z-[60] max-w-[calc(100vw-1rem)] space-y-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-pretty text-left text-[12px] font-normal leading-5 text-slate-600 shadow-sm"
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}
