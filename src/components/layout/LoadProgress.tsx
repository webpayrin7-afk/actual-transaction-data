"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { LabTopProgress } from "@/components/ui/LabLoading";

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


/** (예전 헤더 아래 막대) — 전역 {@link GlobalLoadProgress}로 옮겨 빈 컴포넌트로 둔다 */
export function SiteHeaderLoadProgress() {
  return null;
}

/**
 * 화면 맨 위 진행 막대 — 모든 페이지(상단바 없는 상세 페이지 포함).
 * 첫 데이터 로딩(useLoadProgressWhen)과 페이지 이동(내부 링크 누름 → 주소 바뀜) 동안 보인다.
 */
export function GlobalLoadProgress() {
  const { label, active, show, hide } = useLoadProgress();
  const pathname = usePathname();
  const search = useSearchParams();

  // 내부 링크를 누르면 이동 시작
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(a.href, location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      show(null, "nav");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [show]);

  // 주소가 바뀌면 이동 끝 (혹시 못 끝나도 10초 뒤엔 닫는다)
  useEffect(() => {
    hide("nav");
  }, [pathname, search, hide]);
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => hide("nav"), 10_000);
    return () => window.clearTimeout(t);
  }, [active, hide]);

  return <LabTopProgress active={active} label={label} />;
}
