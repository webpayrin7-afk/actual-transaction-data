"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import type { AptAreaOption } from "@/lib/molit/apt-client";
import {
  areaSelectorClosedLabel,
  areaSelectorDealCountLabel,
  areaSelectorExclusiveLabel,
  areaSelectorPyeongLabel,
  areaSelectorStickyLabel,
  areaSelectorSupplyLabel,
} from "@/lib/apt/area-selector-label";

type AptAreaSelectorProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
  /** Compact trigger for sticky header — same sheet + shared value. */
  variant?: "default" | "compact";
};

const SHEET_MS = 280;

/**
 * Single trigger + bottom sheet area picker.
 * Closed: "33평 · 전용 84.80~84.97㎡ ˅" (no icon / no "면적 선택" label).
 * Sheet: 평형 → 전용 → (공급) · 거래건수. Phase5 boundaries unchanged.
 */
export function AptAreaSelector({
  areas,
  value,
  onChange,
  variant = "default",
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

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        setPresent(false);
        triggerRef.current?.focus({ preventScroll: true });
      }, SHEET_MS);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setOpen(true));
      });
    });
  }

  function pick(key: string) {
    onChange(key);
    close();
  }

  const compact = variant === "compact";

  if (sorted.length <= 1) {
    const only = sorted[0];
    if (!only) {
      return (
        <div
          className={`flex items-center rounded-lg border border-slate-200 bg-white text-slate-700 ${
            compact ? "h-8 px-2.5 text-xs" : "h-10 w-full px-3.5 text-sm"
          }`}
        >
          전체 면적
        </div>
      );
    }
    const onlyLabel = compact
      ? areaSelectorStickyLabel(only)
      : areaSelectorClosedLabel(only);
    return (
      <div
        className={`flex items-center rounded-lg border border-slate-200 bg-white tabular-nums text-slate-800 ${
          compact
            ? "h-8 max-w-[11.5rem] px-2.5 text-xs font-semibold"
            : "h-10 w-full px-3.5 text-sm font-semibold"
        }`}
      >
        <span className="min-w-0 truncate">{onlyLabel}</span>
      </div>
    );
  }

  const totalDeals = sorted.reduce((sum, a) => sum + a.count, 0);
  const isAll = value === "all" || !selected;
  const triggerLabel = isAll
    ? "전체 면적"
    : compact
      ? areaSelectorStickyLabel(selected)
      : areaSelectorClosedLabel(selected);
  const a11yExtra = isAll
    ? `타입 ${sorted.length.toLocaleString("ko-KR")}개 · ${areaSelectorDealCountLabel(totalDeals)}`
    : areaSelectorDealCountLabel(selected.count);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`현재 ${triggerLabel}, ${a11yExtra}`}
        onClick={openSheet}
        className={`flex items-center gap-1.5 border border-slate-200 bg-white text-left tabular-nums text-slate-800 hover:bg-slate-50 ${
          compact
            ? "h-8 max-w-[13rem] rounded-md px-2.5 text-xs font-semibold"
            : "h-10 w-full gap-2 rounded-lg px-3.5 text-sm sm:gap-3"
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${
            compact ? "font-semibold" : "font-semibold"
          }`}
        >
          {triggerLabel}
        </span>
        <ChevronDown
          className={`shrink-0 text-slate-400 transition ${
            compact ? "h-3.5 w-3.5" : "h-4 w-4"
          } ${open ? "rotate-180" : ""}`}
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
    </>
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
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const startY = useRef(0);
  const dragYRef = useRef(0);
  const draggingRef = useRef(false);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const totalDeals = areas.reduce((sum, a) => sum + a.count, 0);

  useLayoutEffect(() => {
    const run = () => {
      const list = listRef.current;
      const el = activeRef.current;
      if (!list || !el || list.clientHeight < 8) return;
      const target =
        el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
      list.scrollTop = Math.max(0, target);
    };
    run();
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }, []);

  function onDragStart(clientY: number) {
    draggingRef.current = true;
    setIsDragging(true);
    startY.current = clientY;
    dragYRef.current = 0;
  }

  function onDragMove(clientY: number) {
    if (!draggingRef.current) return;
    const next = Math.max(0, clientY - startY.current);
    dragYRef.current = next;
    setDragY(next);
  }

  function onDragEnd() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    const finalY = dragYRef.current;
    dragYRef.current = 0;
    if (finalY > 88) {
      setDragY(0);
      onClose();
      return;
    }
    setDragY(0);
  }

  return (
    <div className="fixed inset-0 z-[60]">
      <div
        role="presentation"
        className="absolute inset-0"
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.55)",
          opacity: open ? Math.max(0, 1 - dragY / 280) : 0,
          transition: isDragging
            ? "none"
            : `opacity ${SHEET_MS}ms ease-out`,
        }}
        onClick={onClose}
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 z-10 mx-auto flex w-full max-w-md flex-col bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.18)] outline-none"
        style={{
          maxHeight: "min(75dvh, 100%)",
          transform: open
            ? `translateY(${dragY}px)`
            : "translateY(110%)",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: "hidden",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          transition: isDragging
            ? "none"
            : `transform ${SHEET_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div
          className="relative flex shrink-0 touch-none flex-col bg-white"
          onTouchStart={(e) => onDragStart(e.touches[0].clientY)}
          onTouchMove={(e) => {
            e.preventDefault();
            onDragMove(e.touches[0].clientY);
          }}
          onTouchEnd={onDragEnd}
          onTouchCancel={onDragEnd}
          onMouseDown={(e) => onDragStart(e.clientY)}
          onMouseMove={(e) => {
            if (e.buttons === 1) onDragMove(e.clientY);
          }}
          onMouseUp={onDragEnd}
          onMouseLeave={() => {
            if (draggingRef.current) onDragEnd();
          }}
        >
          <div
            role="presentation"
            className="flex w-full shrink-0 items-center justify-center pb-0.5 pt-2.5"
            style={{ minHeight: 18 }}
          >
            <span className="block h-1 w-9 rounded-full bg-slate-200" />
          </div>

          <div className="relative flex items-center justify-center px-12 pb-3.5 pt-2.5">
            <h2
              id={titleId}
              className="text-center text-lg font-bold leading-none tracking-tight text-slate-900 sm:text-xl"
            >
              평형
            </h2>
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="absolute right-2.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              <X
                className="pointer-events-none h-6 w-6"
                strokeWidth={1.5}
                aria-hidden
              />
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          className="min-h-0 overflow-y-auto overscroll-contain touch-pan-y pb-2"
        >
          <AreaOptionRow
            active={value === "all"}
            buttonRef={value === "all" ? activeRef : undefined}
            onClick={() => onPick("all")}
            pyeongLabel="전체 면적"
            exclusiveLabel={`타입 ${areas.length.toLocaleString("ko-KR")}개`}
            supplyLabel={null}
            dealLabel={areaSelectorDealCountLabel(totalDeals)}
          />
          <div className="mx-4 border-b border-slate-100" aria-hidden />
          {areas.map((area, index) => (
            <div key={area.key}>
              <AreaOptionRow
                active={value === area.key}
                buttonRef={value === area.key ? activeRef : undefined}
                onClick={() => onPick(area.key)}
                pyeongLabel={areaSelectorPyeongLabel(area)}
                exclusiveLabel={areaSelectorExclusiveLabel(area)}
                supplyLabel={areaSelectorSupplyLabel(area)}
                dealLabel={areaSelectorDealCountLabel(area.count)}
              />
              {index < areas.length - 1 ? (
                <div
                  className="mx-4 border-b border-slate-100"
                  aria-hidden
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AreaOptionRow({
  active,
  buttonRef,
  onClick,
  pyeongLabel,
  exclusiveLabel,
  supplyLabel,
  dealLabel,
}: {
  active: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  pyeongLabel: string;
  exclusiveLabel: string;
  supplyLabel: string | null;
  dealLabel: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition ${
        active ? "bg-teal-50" : "hover:bg-slate-50"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span
          className={`block text-[15px] font-semibold tabular-nums leading-snug sm:text-base ${
            active ? "text-teal-900" : "text-slate-900"
          }`}
        >
          {pyeongLabel}
        </span>
        <span className="mt-0.5 block text-[13px] tabular-nums leading-snug text-slate-500">
          {exclusiveLabel}
        </span>
        {supplyLabel ? (
          <span className="mt-0.5 hidden text-[12px] tabular-nums text-slate-400 sm:block">
            {supplyLabel}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
        <span className="text-[13px] tabular-nums text-slate-400">
          {dealLabel}
        </span>
        {active ? (
          <Check className="h-4 w-4 text-teal-700" aria-hidden />
        ) : (
          <span className="h-4 w-4" aria-hidden />
        )}
      </span>
    </button>
  );
}
