"use client";

import {
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const OPEN_MS = 220;
const CLOSE_MS = 180;

type LabBottomSheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Right-side header action label. Defaults to 완료. */
  doneLabel?: string;
  /** Hide the hairline under the title row. */
  hideHeaderDivider?: boolean;
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
}: LabBottomSheetProps) {
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);

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
        aria-labelledby={titleId}
        className="relative z-10 flex w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        style={{
          maxHeight: "65dvh",
          height: "auto",
          transform: visible ? "translateY(0)" : "translateY(100%)",
          transition: `transform ${duration}ms ${easing}`,
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div
          className={`flex shrink-0 items-center justify-between gap-3 px-4 py-3 ${
            hideHeaderDivider ? "" : "border-b border-slate-200"
          }`}
        >
          <h3
            id={titleId}
            className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900"
          >
            {title}
          </h3>
          <button
            type="button"
            className="shrink-0 text-sm font-medium text-teal-700"
            onClick={onClose}
          >
            {doneLabel}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
