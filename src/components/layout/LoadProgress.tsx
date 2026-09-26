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
  /**
   * 페이지 이동("nav") 중인지 — 맨 위 막대는 이것만 본다.
   * 페이지 안 데이터 로딩은 섹션마다 자기 자리에서 로딩을 보이므로(한 번에 표시 하나) 막대를 띄우지 않는다.
   */
  active: boolean;
  /** Pass null/empty label for bar-only. */
  show: (label: string | null, source?: string) => void;
  hide: (source?: string) => void;
};

const DEFAULT_SOURCE = "default";
/** 맨 위 막대를 띄우는 유일한 출처 — 페이지 이동(링크 누름 → 주소 바뀜, 경로 Suspense 대기) */
export const NAV_PROGRESS_SOURCE = "nav";

const LoadProgressContext = createContext<LoadProgressContextValue | null>(
  null,
);


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

  const active = NAV_PROGRESS_SOURCE in bySource;
  const navLabel = bySource[NAV_PROGRESS_SOURCE];
  const label = navLabel && navLabel.length > 0 ? navLabel : null;

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
 * 맨 위 막대를 `active` 동안 켠다 — 페이지 이동 대기(경로 Suspense 자리 등)에만 쓴다.
 * 페이지 안 데이터 로딩에는 쓰지 않는다: 섹션 틀을 먼저 그리고 섹션 안에서 LabSectionLoading/LabDataLoading을 보인다.
 * Message changes only update the label — they must not hide/remount the bar.
 * Pass an empty message for a bar-only indicator (no status text).
 * Uses layout effect so the bar appears before paint on page entry.
 */
export function useLoadProgressWhen(
  active: boolean,
  message: string,
  source = NAV_PROGRESS_SOURCE,
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
 * 페이지 이동(내부 링크 누름 → 주소 바뀜) 동안만 보인다. 페이지 안 데이터 로딩은 각 섹션이 제자리에서 보인다.
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
      show(null, NAV_PROGRESS_SOURCE);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [show]);

  // 주소가 바뀌면 이동 끝 (혹시 못 끝나도 10초 뒤엔 닫는다)
  useEffect(() => {
    hide(NAV_PROGRESS_SOURCE);
  }, [pathname, search, hide]);
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => hide(NAV_PROGRESS_SOURCE), 10_000);
    return () => window.clearTimeout(t);
  }, [active, hide]);

  return <LabTopProgress active={active} label={label} />;
}
