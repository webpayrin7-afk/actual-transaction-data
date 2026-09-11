"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

type LoadProgressContextValue = {
  /** Non-empty status text under the bar; null = bar only / hidden text */
  label: string | null;
  /** Whether any progress source is active */
  active: boolean;
  /** Pass null/empty label for bar-only. */
  show: (label: string | null, source?: string) => void;
  hide: (source?: string) => void;
};

const DEFAULT_SOURCE = "default";

const LoadProgressContext = createContext<LoadProgressContextValue | null>(
  null,
);

function resolveLabel(bySource: Record<string, string | null>): string | null {
  const order = ["query", "default", "nav"] as const;
  for (const key of order) {
    if (key in bySource) {
      const value = bySource[key];
      return value && value.length > 0 ? value : null;
    }
  }
  const keys = Object.keys(bySource);
  if (keys.length === 0) return null;
  const value = bySource[keys[keys.length - 1]];
  return value && value.length > 0 ? value : null;
}

export function LoadProgressProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [bySource, setBySource] = useState<Record<string, string | null>>({});

  const show = useCallback((label: string | null, source = DEFAULT_SOURCE) => {
    const nextLabel = label && label.length > 0 ? label : null;
    setBySource((prev) =>
      source in prev && prev[source] === nextLabel
        ? prev
        : { ...prev, [source]: nextLabel },
    );
  }, []);

  const hide = useCallback((source = DEFAULT_SOURCE) => {
    setBySource((prev) => {
      if (!(source in prev)) return prev;
      const next = { ...prev };
      delete next[source];
      return next;
    });
  }, []);

  const active = Object.keys(bySource).length > 0;
  const label = useMemo(() => resolveLabel(bySource), [bySource]);

  const value = useMemo(
    () => ({ label, active, show, hide }),
    [label, active, show, hide],
  );

  return (
    <LoadProgressContext.Provider value={value}>
      {children}
    </LoadProgressContext.Provider>
  );
}

export function useLoadProgress() {
  const ctx = useContext(LoadProgressContext);
  if (!ctx) {
    return {
      label: null as string | null,
      active: false,
      show: (() => {}) as (label: string | null, source?: string) => void,
      hide: (() => {}) as (source?: string) => void,
    };
  }
  return ctx;
}

/**
 * Header progress while `active` (e.g. first query load).
 * Message changes only update the label — they must not hide/remount the bar.
 * Pass an empty message for a bar-only indicator (no status text).
 * Uses layout effect so the bar appears before paint on page entry.
 */
export function useLoadProgressWhen(
  active: boolean,
  message: string,
  source = "query",
) {
  const { show, hide } = useLoadProgress();

  useLayoutEffect(() => {
    if (active) show(message.length > 0 ? message : null, source);
    else hide(source);
  }, [active, message, source, show, hide]);

  // Unmount only — do not hide when `message` changes (that remounts the bar).
  useLayoutEffect(() => {
    return () => hide(source);
  }, [source, hide]);
}


/** SiteHeader 하단에 붙여 렌더 — fixed top 계산 없이 헤더와 한 덩어리 */
export function SiteHeaderLoadProgress() {
  const { label, active } = useLoadProgress();
  const [displayLabel, setDisplayLabel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (active) {
      const frame = window.requestAnimationFrame(() => {
        setOpen(true);
        setDisplayLabel(label);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const t = window.setTimeout(() => {
      setOpen(false);
      setDisplayLabel(null);
    }, 80);
    return () => window.clearTimeout(t);
  }, [active, label]);

  if (!open) return null;

  const text = label ?? displayLabel;

  return (
    <div role="status" aria-live="polite">
      <div className="relative h-1 w-full overflow-hidden bg-teal-100/90">
        <div className="absolute inset-y-0 w-1/3 animate-[apt-load-progress_1.15s_ease-in-out_infinite] rounded-full bg-teal-600" />
      </div>
      {text ? (
        <div className="border-t border-teal-100/80 bg-teal-50/95 px-4 py-2 text-center text-xs font-medium text-teal-800 sm:px-6">
          {text}
        </div>
      ) : null}
    </div>
  );
}
