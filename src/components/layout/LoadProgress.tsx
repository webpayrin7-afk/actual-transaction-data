"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

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
    // Prefer data-fetch labels over route navigation
    if (bySource.query) return bySource.query;
    if (bySource.default) return bySource.default;
    if (bySource.nav) return bySource.nav;
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

/** Header progress while `active` (e.g. first query load). */
export function useLoadProgressWhen(
  active: boolean,
  message: string,
  source = "query",
) {
  const { show, hide } = useLoadProgress();
  useEffect(() => {
    if (active) show(message, source);
    else hide(source);
    return () => hide(source);
  }, [active, message, source, show, hide]);
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

/**
 * Soft-nav feedback: show the same header bar while a same-origin
 * <Link> navigation is in flight, then clear on route change.
 */
export function NavigationLoadProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { show, hide } = useLoadProgress();

  useEffect(() => {
    hide("nav");
  }, [pathname, searchParams, hide]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const hrefAttr = anchor.getAttribute("href");
      if (!hrefAttr || hrefAttr.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;

      const nextSearch = url.search.startsWith("?")
        ? url.search.slice(1)
        : url.search;
      const curSearch = searchParams.toString();
      if (url.pathname === pathname && nextSearch === curSearch) return;

      show("페이지 불러오는 중…", "nav");
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pathname, searchParams, show]);

  return null;
}
