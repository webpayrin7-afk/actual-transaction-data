"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import {
  formatAreaTriggerLabel,
  formatExclusiveArea,
  formatPyeong,
} from "@/lib/utils/format";

type AptAreaSelectorProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
};

const SHEET_MS = 280;

/**
 * 단일 버튼 + bottom sheet 면적 선택.
 * areaKey / onChange / default-area 로직과 독립 — UI만.
 */
export function AptAreaSelector({
  areas,
  value,
  onChange,
}: AptAreaSelectorProps) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sorted = [...areas].sort(
    (a, b) => a.exclusiveArea - b.exclusiveArea,
  );
  const selected = sorted.find((a) => a.key === value) ?? null;

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!present) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const triggerEl = triggerRef.current;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      // silence unused in cleanup path
      void triggerEl;
    };
  }, [present]);

  function close() {
    setOpen(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setPresent(false);
      triggerRef.current?.focus({ preventScroll: true });
    }, SHEET_MS);
  }

  function openSheet() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setPresent(true);
    setOpen(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setOpen(true));
    });
  }

  function pick(key: string) {
    onChange(key);
    close();
  }

  if (sorted.length <= 1) {
    const only = sorted[0];
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="shrink-0 text-xs text-slate-500">면적</span>
        <span className="text-sm tabular-nums text-slate-800">
          {only ? formatAreaTriggerLabel(only.exclusiveArea) : "전체 면적"}
        </span>
      </div>
    );
  }

  const triggerLabel =
    value === "all" || !selected
      ? "전체 면적"
      : formatAreaTriggerLabel(selected.exclusiveArea);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="shrink-0 text-xs text-slate-500">면적</span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openSheet}
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-800 hover:bg-slate-50"
      >
        <span className="truncate tabular-nums">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </button>

      {present
        ? createPortal(
            <AreaSheet
              titleId={titleId}
              sheetRef={sheetRef}
              value={value}
              areas={sorted}
              open={open}
              onClose={close}
              onPick={pick}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function AreaSheet({
  titleId,
  sheetRef,
  value,
  areas,
  open,
  onClose,
  onPick,
}: {
  titleId: string;
  sheetRef: React.RefObject<HTMLDivElement | null>;
  value: string;
  areas: AptAreaOption[];
  open: boolean;
  onClose: () => void;
  onPick: (key: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-[60]">
      <div
        role="presentation"
        className="absolute inset-0 bg-black/50"
        style={{
          opacity: open ? 1 : 0,
          transition: `opacity ${SHEET_MS}ms ease-out`,
        }}
        onClick={onClose}
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute left-0 right-0 z-10 mx-auto flex w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.18)] outline-none"
        style={{
          height: "66.666dvh",
          bottom: open ? 0 : "-66.666dvh",
          transition: `bottom ${SHEET_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div className="flex shrink-0 justify-center pt-2.5 pb-1" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-slate-200" />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2.5">
          <h2 id={titleId} className="text-sm font-semibold text-slate-900">
            면적 선택
          </h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="pointer-events-none h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-slate-100 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <AreaOption
            active={value === "all"}
            onClick={() => onPick("all")}
            primary="전체 면적"
          />
          {areas.map((area) => (
            <AreaOption
              key={area.key}
              active={area.key === value}
              onClick={() => onPick(area.key)}
              primary={formatPyeong(area.exclusiveArea)}
              secondary={formatExclusiveArea(area.exclusiveArea)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AreaOption({
  active,
  onClick,
  primary,
  secondary,
}: {
  active: boolean;
  onClick: () => void;
  primary: string;
  secondary?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
        active ? "bg-slate-100" : "hover:bg-slate-50"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span
          className={`block text-sm ${
            active
              ? "font-semibold text-slate-900"
              : "font-medium text-slate-800"
          }`}
        >
          {primary}
        </span>
        {secondary ? (
          <span className="mt-0.5 block text-xs tabular-nums text-slate-500">
            {secondary}
          </span>
        ) : null}
      </span>
      {active ? (
        <Check className="h-4 w-4 shrink-0 text-teal-700" aria-hidden />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
    </button>
  );
}
