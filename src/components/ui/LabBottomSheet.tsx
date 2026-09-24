"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const OPEN_MS = 220;
const CLOSE_MS = 180;
/** 손잡이를 이만큼 넘게 끌어내리면 닫는다 (px) */
const DRAG_CLOSE_PX = 80;

type LabBottomSheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Right-side header action label. Defaults to 완료. */
  doneLabel?: string;
  /** Hide the hairline under the title row. */
  hideHeaderDivider?: boolean;
  /** Tighten top padding above sheet body copy. */
  compactBodyTop?: boolean;
  /** Fixed area under the scrolling body (e.g. result count + 초기화 / 적용). */
  footer?: ReactNode;
  /** Small note right after the title (e.g. what a chart means). */
  titleNote?: ReactNode;
  /** tall: long forms (e.g. 지도 조건) open to 88% of the viewport instead of 65%. */
  size?: "default" | "tall";
  /** Replaces the title row (title stays as the dialog's accessible name). */
  header?: ReactNode;
  /** Centered grab bar; dragging it down past 80px closes the sheet. */
  dragHandle?: boolean;
  /** Hide the right-side done button (close via handle, backdrop or footer). */
  hideDone?: boolean;
  /** The scrolling body element (e.g. for a scroll-spy header). */
  bodyRef?: RefObject<HTMLDivElement | null>;
};

/**
 * LAB Series bottom sheet — content-height, calm slide motion, safe-area aware.
 * No bounce / spring. Respects prefers-reduced-motion.
 */
export function LabBottomSheet({
  open,
  onClose,
  title,
  children,
  doneLabel = "완료",
  hideHeaderDivider = false,
  compactBodyTop = false,
  footer,
  titleNote,
  size = "default",
  header,
  dragHandle = false,
  hideDone = false,
  bodyRef,
}: LabBottomSheetProps) {
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Mount / unmount + enter/exit animation. State updates are scheduled
  // (rAF / timeout) so we do not call setState synchronously inside the effect.
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      let raf2 = 0;
      const raf1 = window.requestAnimationFrame(() => {
        setMounted(true);
        raf2 = window.requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        window.cancelAnimationFrame(raf1);
        window.cancelAnimationFrame(raf2);
        document.body.style.overflow = prev;
      };
    }

    let timeoutId = 0;
    const raf = window.requestAnimationFrame(() => {
      setVisible(false);
      const ms = reducedMotion ? 0 : CLOSE_MS;
      timeoutId = window.setTimeout(() => setMounted(false), ms);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeoutId);
    };
  }, [open, reducedMotion]);

  if (!mounted || typeof document === "undefined") return null;

  const duration = reducedMotion ? 0 : visible ? OPEN_MS : CLOSE_MS;
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStart.current == null) return;
    setDragY(Math.max(0, e.clientY - dragStart.current));
  };
  const onHandleUp = () => {
    if (dragStart.current == null) return;
    const shouldClose = dragY > DRAG_CLOSE_PX;
    dragStart.current = null;
    setDragging(false);
    setDragY(0);
    if (shouldClose) onClose();
  };
  const easing = visible ? "ease-out" : "ease-in";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40"
        aria-label="닫기"
        style={{
          opacity: visible ? 1 : 0,
          transition: `opacity ${duration}ms ${easing}`,
        }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={header ? undefined : titleId}
        aria-label={header ? title : undefined}
        className="relative z-10 flex w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        style={{
          maxHeight: size === "tall" ? "88dvh" : "65dvh",
          height: "auto",
          transform: visible ? `translateY(${dragY}px)` : "translateY(100%)",
          transition: dragging ? "none" : `transform ${duration}ms ${easing}`,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {dragHandle ? (
          <div
            className="flex h-9 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            aria-hidden
          >
            <span className="h-1 w-10 rounded-full bg-slate-300" />
          </div>
        ) : null}
        {header ? (
          <div className="shrink-0 px-4">{header}</div>
        ) : (
          <div
            className={`flex shrink-0 items-center justify-between gap-3 px-4 ${
              hideHeaderDivider ? `${dragHandle ? "pt-0" : "pt-5"} pb-2` : "border-b border-slate-200 py-3"
            }`}
          >
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h3
                id={titleId}
                className="shrink-0 truncate text-base font-semibold leading-snug text-slate-900"
              >
                {title}
              </h3>
              {titleNote ? <span className="detail-meta min-w-0 truncate">{titleNote}</span> : null}
            </div>
            {hideDone ? null : (
              <button
                type="button"
                className="shrink-0 text-sm font-medium text-teal-700"
                onClick={onClose}
              >
                {doneLabel}
              </button>
            )}
          </div>
        )}
        <div
          ref={bodyRef}
          className={`relative min-h-0 flex-1 overflow-y-auto px-4 pb-4 ${
            compactBodyTop ? "pt-2" : "pt-4"
          }`}
        >
          {children}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-[color:var(--lab-border)] px-4 pt-3 pb-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
