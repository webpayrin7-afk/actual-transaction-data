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

  useEffect(() => {
    if (open) {
      setMounted(true);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const id = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        window.cancelAnimationFrame(id);
        document.body.style.overflow = prev;
      };
    }

    setVisible(false);
    if (!mounted) return;
    const ms = reducedMotion ? 0 : CLOSE_MS;
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, mounted, reducedMotion]);

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
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3
            id={titleId}
            className="text-base font-semibold text-slate-900"
          >
            {title}
          </h3>
          <button
            type="button"
            className="text-sm font-medium text-teal-700"
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
