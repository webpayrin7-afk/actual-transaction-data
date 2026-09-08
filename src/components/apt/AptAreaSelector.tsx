"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, RefreshCw, X } from "lucide-react";
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
 * 단일 버튼 + bottom sheet 면적 선택 (네이버 부동산 스타일).
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setOpen(true));
    });
  }

  function pick(key: string) {
    onChange(key);
    requestClose();
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

function areaRowLabel(sqm: number, unit: "sqm" | "py"): string {
  if (unit === "py") {
    return `${formatPyeong(sqm)} (${formatSqm(sqm)})`;
  }
  return `${formatSqm(sqm)} (${formatPyeong(sqm)})`;
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
  const [unit, setUnit] = useState<"sqm" | "py">("sqm");

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center">
      <button
        type="button"
        aria-label="면적 선택 닫기"
        className={`absolute inset-0 bg-black/40 transition-opacity ease-out ${
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
        className={`relative z-[61] flex max-h-[min(88dvh,40rem)] w-full flex-col overflow-hidden rounded-t-[20px] bg-white outline-none sm:max-w-md transition-transform ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ transitionDuration: `${SHEET_MS}ms` }}
      >
        {/* 네이버형: 제목 중앙 + 우측 X */}
        <div className="relative flex shrink-0 items-center justify-center px-12 pb-3 pt-5">
          <h2
            id={titleId}
            className="text-[17px] font-bold tracking-tight text-slate-900"
          >
            면적 선택
          </h2>
          <button
            type="button"
            data-sheet-close
            aria-label="닫기"
            onClick={onClose}
            className="absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        {/* 평 전환 토글 */}
        <div className="flex shrink-0 items-center justify-between px-4 pb-3">
          <button
            type="button"
            aria-pressed={unit === "py"}
            onClick={() => setUnit((u) => (u === "py" ? "sqm" : "py"))}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition ${
              unit === "py"
                ? "border-slate-800 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            평
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-slate-100 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <ul>
            <li className="border-b border-slate-100">
              <AreaOption
                active={value === "all"}
                onClick={() => onPick("all")}
                label="전체 면적"
              />
            </li>
            {areas.map((area) => (
              <li key={area.key} className="border-b border-slate-100 last:border-b-0">
                <AreaOption
                  active={area.key === value}
                  onClick={() => onPick(area.key)}
                  label={areaRowLabel(area.exclusiveArea, unit)}
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
  /** 괄호 바로 오른쪽 회색 보조 수치 */
  meta?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-4 py-[14px] text-left transition ${
        active ? "bg-slate-50" : "active:bg-slate-50"
      }`}
    >
      <span className="inline tabular-nums text-[15px] leading-snug text-slate-900">
        {label}
        {meta ? (
          <span className="text-[15px] font-normal text-slate-400">
            {" "}
            {meta}
          </span>
        ) : null}
      </span>
    </button>
  );
}
