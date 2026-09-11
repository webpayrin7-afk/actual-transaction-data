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
  /** Non-empty status text under the bar; null = bar only / hidden text */
  label: string | null;
  /** Whether any progress source is active */
  active: boolean;
  /** Pass null/empty label for bar-only (e.g. soft navigation). */
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
 */
export function useLoadProgressWhen(
  active: boolean,
  message: string,
  source = "query",
) {
  const { show, hide } = useLoadProgress();

  useEffect(() => {
    if (active) show(message.length > 0 ? message : null, source);
    else hide(source);
  }, [active, message, source, show, hide]);

  // Unmount only — do not hide when `message` changes (that remounts the bar).
  useEffect(() => {
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
      setOpen(true);
      setDisplayLabel(label);
      return;
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

/**
 * Soft-nav when entering a region detail (`/region/...`) — shows labeled
 * progress through Suspense until RegionDailyStatus query progress takes over.
 * `/regions` index stays quiet (no progress).
 */
export function NavigationLoadProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { show, hide } = useLoadProgress();

  useEffect(() => {
    const dest = pathname.replace(/\/$/, "") || "/";
    // Keep bar up briefly on region detail so query progress can take over.
    const delay = dest.startsWith("/region/") ? 500 : 80;
    const t = window.setTimeout(() => hide("nav"), delay);
    return () => window.clearTimeout(t);
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

      const dest = url.pathname.replace(/\/$/, "") || "/";
      // Region detail only (not /regions index).
      if (!dest.startsWith("/region/")) return;

      const nextSearch = url.search.startsWith("?")
        ? url.search.slice(1)
        : url.search;
      const curSearch = searchParams.toString();
      const here = pathname.replace(/\/$/, "") || "/";
      if (dest === here && nextSearch === curSearch) return;

      show("시장 현황 불러오는 중…", "nav");
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pathname, searchParams, show]);

  return null;
}
