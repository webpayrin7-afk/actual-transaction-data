"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type LoadProgressContextValue = {
  label: string | null;
  show: (label: string, source?: string) => void;
  hide: (source?: string) => void;
};

const DEFAULT_SOURCE = "default";

const LoadProgressContext = createContext<LoadProgressContextValue | null>(
  null,
);

export function LoadProgressProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [bySource, setBySource] = useState<Record<string, string>>({});

  const show = useCallback((label: string, source = DEFAULT_SOURCE) => {
    setBySource((prev) =>
      prev[source] === label ? prev : { ...prev, [source]: label },
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

  const label = useMemo(() => {
    if (bySource.query) return bySource.query;
    if (bySource.default) return bySource.default;
    const keys = Object.keys(bySource);
    if (keys.length === 0) return null;
    return bySource[keys[keys.length - 1]] ?? null;
  }, [bySource]);

  const value = useMemo(
    () => ({ label, show, hide }),
    [label, show, hide],
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
      show: (() => {}) as (label: string, source?: string) => void,
      hide: (() => {}) as (source?: string) => void,
    };
  }
  return ctx;
}

/**
 * Header progress while `active` (e.g. first query load).
 * Message changes only update the label — they must not hide/remount the bar.
 */
export function useLoadProgressWhen(
  active: boolean,
  message: string,
  source = "query",
) {
  const { show, hide } = useLoadProgress();

  useEffect(() => {
    if (active) show(message, source);
    else hide(source);
  }, [active, message, source, show, hide]);

  // Unmount only — do not hide when `message` changes (that remounts the bar).
  useEffect(() => {
    return () => hide(source);
  }, [source, hide]);
}

/** SiteHeader 하단에 붙여 렌더 — fixed top 계산 없이 헤더와 한 덩어리 */
export function SiteHeaderLoadProgress() {
  const { label } = useLoadProgress();
  // Keep the bar mounted across brief source handoffs; only swap the text.
  const [displayLabel, setDisplayLabel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (label) {
      setDisplayLabel(label);
      setOpen(true);
      return;
    }
    const t = window.setTimeout(() => {
      setOpen(false);
      setDisplayLabel(null);
    }, 80);
    return () => window.clearTimeout(t);
  }, [label]);

  if (!open || !displayLabel) return null;

  return (
    <div role="status" aria-live="polite">
      <div className="relative h-1 w-full overflow-hidden bg-teal-100/90">
        <div className="absolute inset-y-0 w-1/3 animate-[apt-load-progress_1.15s_ease-in-out_infinite] rounded-full bg-teal-600" />
      </div>
      <div className="border-t border-teal-100/80 bg-teal-50/95 px-4 py-2 text-center text-xs font-medium text-teal-800 sm:px-6">
        {label ?? displayLabel}
      </div>
    </div>
  );
}
