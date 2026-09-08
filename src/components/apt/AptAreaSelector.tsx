"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useEffect,
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
    // mount → layout scroll(선택 평수) → 그다음 slide-up
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

  if (sorted.length <= 1) {
    const only = sorted[0];
    return (
      <span className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2.5 text-sm tabular-nums text-slate-700">
        {only ? formatAreaTriggerLabel(only.exclusiveArea) : "전체 면적"}
      </span>
    );
  }

  const triggerLabel =
    value === "all" || !selected
      ? "전체 면적"
      : formatAreaTriggerLabel(selected.exclusiveArea);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`면적 선택, 현재 ${triggerLabel}`}
        onClick={openSheet}
        className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
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

  const rows: { key: string; label: string }[] = [
    { key: "all", label: "전체 면적" },
    ...areas.map((area) => ({
      key: area.key,
      label: `${formatPyeong(area.exclusiveArea)} (${formatExclusiveArea(area.exclusiveArea)})`,
    })),
  ];

  // 시트 마운트 직후(올라오기 전) 선택 항목으로 스크롤 고정
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
        className="absolute left-0 right-0 z-10 mx-auto flex w-full max-w-md flex-col bg-white shadow-[0_-8px_30px_rgba(15,23,42,0.18)] outline-none"
        style={{
          height: "66.666dvh",
          bottom: open ? -dragY : "-66.666dvh",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: "hidden",
          transition: isDragging
            ? "none"
            : `bottom ${SHEET_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
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
          {/* 상단 중앙 스와이프 핸들 */}
          <div
            role="presentation"
            style={{
              display: "flex",
              width: "100%",
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
              paddingTop: 10,
              paddingBottom: 2,
              minHeight: 18,
            }}
          >
            <span
              style={{
                display: "block",
                width: 36,
                height: 4,
                borderRadius: 999,
                backgroundColor: "#e2e8f0",
              }}
            />
          </div>

          <div
            className="relative flex items-center justify-center px-12"
            style={{ paddingTop: 12, paddingBottom: 22 }}
          >
            <h2
              id={titleId}
              className="text-center leading-none tracking-tight text-slate-900"
              style={{ fontSize: 20, fontWeight: 700 }}
            >
              면적 선택
            </h2>
            <button
              type="button"
              aria-label="닫기"
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
              }}
            >
              <X
                className="pointer-events-none h-6 w-6"
                strokeWidth={1.5}
                aria-hidden
              />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            ref={listRef}
            className="absolute inset-0 overflow-y-auto overscroll-contain touch-pan-y pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          >
            {rows.map((row, index) => (
              <div key={row.key}>
                <AreaOption
                  active={value === row.key}
                  buttonRef={value === row.key ? activeRef : undefined}
                  onClick={() => onPick(row.key)}
                  label={row.label}
                />
                {index < rows.length - 1 ? (
                  <div className="mx-4 border-b border-slate-100" aria-hidden />
                ) : null}
              </div>
            ))}
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-white to-transparent"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-white to-transparent"
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}

function AreaOption({
  active,
  buttonRef,
  onClick,
  label,
}: {
  active: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
        active ? "bg-slate-100" : "hover:bg-slate-50"
      }`}
    >
      <span
        className={`min-w-0 flex-1 truncate tabular-nums ${
          active
            ? "font-semibold text-slate-900"
            : "font-medium text-slate-800"
        }`}
        style={{ fontSize: 15 }}
      >
        {label}
      </span>
      {active ? (
        <Check className="h-4 w-4 shrink-0 text-teal-700" aria-hidden />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
    </button>
  );
}
