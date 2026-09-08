"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type LoadProgressContextValue = {
  label: string | null;
  show: (label: string) => void;
  hide: () => void;
};

const LoadProgressContext = createContext<LoadProgressContextValue | null>(
  null,
);

export function LoadProgressProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const show = useCallback((next: string) => setLabel(next), []);
  const hide = useCallback(() => setLabel(null), []);
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
      show: (_: string) => {},
      hide: () => {},
    };
  }
  return ctx;
}

/** SiteHeader 하단에 붙여 렌더 — fixed top 계산 없이 헤더와 한 덩어리 */
export function SiteHeaderLoadProgress() {
  const { label } = useLoadProgress();
  if (!label) return null;

  return (
    <div role="status" aria-live="polite">
      <div className="relative h-1 w-full overflow-hidden bg-teal-100/90">
        <div className="absolute inset-y-0 w-1/3 animate-[apt-load-progress_1.15s_ease-in-out_infinite] rounded-full bg-teal-600" />
      </div>
      <div className="border-t border-teal-100/80 bg-teal-50/95 px-4 py-2 text-center text-xs font-medium text-teal-800 sm:px-6">
        {label}
      </div>
    </div>
  );
}
