"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt";
import {
  formatAreaTriggerLabel,
  formatPyeong,
  formatSqm,
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
        setOpen(false);
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => {
          setPresent(false);
          triggerEl?.focus();
        }, SHEET_MS);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [present]);

  useEffect(() => {
    if (!open) return;
    const focusTarget =
      sheetRef.current?.querySelector<HTMLElement>("[data-sheet-close]") ??
      sheetRef.current;
    focusTarget?.focus();
  }, [open]);

  function requestClose() {
    setOpen(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setPresent(false);
      triggerRef.current?.focus();
    }, SHEET_MS);
  }

  function openSheet() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setPresent(true);
    // next frame → slide-up transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setOpen(true));
    });
  }

  function pick(key: string) {
    onChange(key);
    requestClose();
  }

  // 면적 0~1개: static (chevron/sheet 없음)
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
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-800 hover:bg-slate-50"
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
              onClose={requestClose}
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
    <div className="fixed inset-0 z-[60] flex items-end justify-center">
      <button
        type="button"
        aria-label="면적 선택 닫기"
        className={`absolute inset-0 bg-slate-900/40 transition-opacity duration-280 ease-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
        style={{ transitionDuration: `${SHEET_MS}ms` }}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative z-[61] flex w-full max-h-[min(40vh,16rem)] flex-col overflow-hidden rounded-t-3xl border border-slate-200/90 bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.12)] outline-none sm:max-w-md transition-transform ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ transitionDuration: `${SHEET_MS}ms` }}
      >
        {/* drag affordance */}
        <div className="flex shrink-0 justify-center pt-2 pb-0.5" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-slate-200" />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-1.5">
          <h2 id={titleId} className="text-[13px] font-semibold text-slate-900">
            면적 선택
          </h2>
          <button
            type="button"
            data-sheet-close
            aria-label="닫기"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto overscroll-contain border-t border-slate-100 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <ul className="divide-y divide-slate-100">
            <li>
              <AreaOption
                active={value === "all"}
                onClick={() => onPick("all")}
                label="전체 면적"
              />
            </li>
            {areas.map((area) => (
              <li key={area.key}>
                <AreaOption
                  active={area.key === value}
                  onClick={() => onPick(area.key)}
                  label={`${formatPyeong(area.exclusiveArea)} (${formatSqm(area.exclusiveArea)})`}
                  meta={`${area.count.toLocaleString("ko-KR")}건`}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function AreaOption({
  active,
  onClick,
  label,
  meta,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  /** 괄호 바로 오른쪽 보조 수치 */
  meta?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-4 py-2 text-left transition ${
        active ? "bg-slate-100" : "hover:bg-slate-50"
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] tabular-nums">
        <span
          className={
            active
              ? "font-semibold text-slate-900"
              : "font-medium text-slate-800"
          }
        >
          {label}
        </span>
        {meta ? (
          <span className="ml-1 text-[12px] text-slate-400">{meta}</span>
        ) : null}
      </span>
      {active ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-teal-700" aria-hidden />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
    </button>
  );
}
