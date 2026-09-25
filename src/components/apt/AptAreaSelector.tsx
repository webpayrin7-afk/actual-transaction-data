"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { formatEok } from "@/lib/utils/format";
import type { AptAreaOption } from "@/lib/molit/apt-client";
import {
  areaSelectorClosedLabel,
  areaSelectorDealCountLabel,
  areaSelectorExclusiveLabel,
  areaSelectorPyeongLabel,
  areaSelectorSupplyLabel,
} from "@/lib/apt/area-selector-label";

type AptAreaSelectorProps = {
  areas: AptAreaOption[];
  value: string;
  onChange: (key: string) => void;
  /** Compact trigger for sticky header — same sheet + shared value. */
  variant?: "default" | "compact";
  /** Extra classes on the closed trigger (archive top uses muted surface). */
  triggerClassName?: string;
};

const SHEET_MS = 280;

const PYEONG_TEXT =
  "font-semibold text-[color:var(--lab-teal-700)]";

function AreaTriggerLabel({ area }: { area: AptAreaOption }) {
  const pyeong = areaSelectorPyeongLabel(area);
  const exclusive = areaSelectorExclusiveLabel(area);
  // Sticky + closed both show exclusive so the trigger can grow with real text
  // (max-width alone does not widen short labels).
  if (!pyeong) {
    return <span className={PYEONG_TEXT}>{exclusive}</span>;
  }
  return (
    <>
      <span className={PYEONG_TEXT}>{pyeong}</span>
      <span className="font-semibold text-slate-800">
        {` · ${exclusive}`}
      </span>
    </>
  );
}

/**
 * Single trigger + bottom sheet area picker.
 * Closed: "33평 · 전용 84.80~84.97㎡ ˅"
 * Sheet: 평형 → 전용+거래건수 → (공급); 선택 체크는 맨 오른쪽 세로 가운데. Phase5 boundaries unchanged.
 */
export function AptAreaSelector({
  areas,
  value,
  onChange,
  variant = "default",
  triggerClassName = "",
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
  // 랩 UI 가이드 11.0 — 면적은 3차 조건: 둥근 필터 칩(누르면 바텀시트). 본문·스티키 같은 모양 (LabFilterChips와 같은 규격)
  const chip =
    "relative inline-flex h-9 min-w-0 max-w-full items-center gap-0.5 whitespace-nowrap rounded-full border px-3 text-[14px] leading-5 tabular-nums before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";
  const chipOn =
    // 평형은 늘 하나가 골라진 값이라 청록 면(필터 걸림 표시) 대신 흰 면 + 회색 테두리, "34평"만 청록 글씨
    "border-[color:var(--lab-border-control)] bg-white font-semibold text-[color:var(--lab-navy-950)]";
  const chipOff =
    "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] font-medium text-[color:var(--lab-navy-950)]";
  // 본문은 폭 전체(글자 왼쪽 · ▾ 오른쪽 끝), 스티키는 글자 길이만큼
  const width = compact ? "" : "w-full justify-between px-4";

  if (sorted.length <= 1) {
    const only = sorted[0];
    if (!only) {
      return (
        <div className={`${chip} ${width} ${chipOff} ${triggerClassName}`}>전체 면적</div>
      );
    }
    return (
      <div className={`${chip} ${width} ${chipOn} ${triggerClassName}`}>
        <span className="min-w-0 truncate">
          <AreaTriggerLabel area={only} />
        </span>
      </div>
    );
  }

  const totalDeals = sorted.reduce((sum, a) => sum + a.count, 0);
  const isAll = value === "all" || !selected;
  const triggerLabel = isAll
    ? "전체 면적"
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
        className={`${chip} ${width} ${isAll || !selected ? chipOff : chipOn} text-left ${triggerClassName}`}
      >
        <span className="min-w-0 truncate">
          {isAll || !selected ? (
            <span className="font-semibold">전체 면적</span>
          ) : (
            <AreaTriggerLabel area={selected} />
          )}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`} aria-hidden />
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
  const latestOfAll = areas.reduce<AptAreaOption["latestTrade"]>(
    (best, a) => (a.latestTrade && (!best || a.latestTrade.date > best.date) ? a.latestTrade : best),
    null,
  );

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
              className="text-center detail-section-title"
            >
              평형 선택
            </h2>
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
            exclusiveLabel={`평형 ${areas.length.toLocaleString("ko-KR")}개`}
            supplyLabel={null}
            dealLabel={areaSelectorDealCountLabel(totalDeals)}
            latest={latestOfAll}
          />
          <div className="mx-4 border-b border-slate-100" aria-hidden />
          {areas.map((area, index) => (
            <div key={area.key}>
              <AreaOptionRow
                active={value === area.key}
                buttonRef={value === area.key ? activeRef : undefined}
                onClick={() => onPick(area.key)}
                pyeongLabel={
                  areaSelectorPyeongLabel(area) ??
                  areaSelectorExclusiveLabel(area)
                }
                exclusiveLabel={
                  areaSelectorPyeongLabel(area)
                    ? areaSelectorExclusiveLabel(area)
                    : ""
                }
                supplyLabel={areaSelectorSupplyLabel(area)}
                dealLabel={areaSelectorDealCountLabel(area.count)}
                householdsLabel={area.households ? `${area.households.toLocaleString("ko-KR")}세대` : null}
                latest={area.latestTrade}
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

/** 26.05.29 */
function shortDate(d: string): string {
  return d.length >= 10 ? `${d.slice(2, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}` : d;
}

/**
 * 평형 한 줄 — 왼쪽: 평형·세대 / 전용·공급, 오른쪽: 최근 매매 실거래가 / 계약일·거래 건수.
 * 호가가 아니라 실거래라 날짜를 같이 둔다. 신고가면 작은 표시.
 */
function AreaOptionRow({
  active,
  buttonRef,
  onClick,
  pyeongLabel,
  exclusiveLabel,
  supplyLabel,
  dealLabel,
  householdsLabel = null,
  latest,
}: {
  active: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  pyeongLabel: string;
  exclusiveLabel: string;
  supplyLabel: string | null;
  dealLabel: string;
  householdsLabel?: string | null;
  latest?: AptAreaOption["latestTrade"];
}) {
  const sub = [exclusiveLabel, supplyLabel].filter(Boolean).join(" · ");
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition ${
        active ? "bg-teal-50" : "hover:bg-slate-50"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="detail-number leading-snug text-[color:var(--lab-teal-700)]">{pyeongLabel}</span>
          {householdsLabel ? <span className="detail-meta tabular-nums">{householdsLabel}</span> : null}
        </span>
        {sub ? <span className="detail-meta mt-0.5 block tabular-nums">{sub}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        {latest !== undefined ? (
          <>
            <span className="flex items-center justify-end gap-1">
              {latest?.singoga ? (
                <span className="shrink-0 whitespace-nowrap rounded border border-rose-400 px-1 py-px text-[12px] font-semibold leading-4 text-rose-600">
                  신고가
                </span>
              ) : null}
              <span className={`detail-number leading-snug tabular-nums ${latest ? "text-[color:var(--lab-navy-950)]" : "text-slate-400"}`}>
                {latest ? formatEok(latest.amount) : "매매 없음"}
              </span>
            </span>
            <span className="detail-meta mt-0.5 block tabular-nums">
              {latest ? `${shortDate(latest.date)} · ` : ""}
              {dealLabel}
            </span>
          </>
        ) : (
          <span className="detail-meta tabular-nums">{dealLabel}</span>
        )}
      </span>
      <span className="flex w-5 shrink-0 items-center justify-center">
        {active ? (
          <Check className="h-5 w-5 text-teal-700" strokeWidth={2.5} aria-hidden />
        ) : (
          <span className="h-5 w-5" aria-hidden />
        )}
      </span>
    </button>
  );
}
