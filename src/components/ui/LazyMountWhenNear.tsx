"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LabSectionLoading } from "@/components/ui/LabLoading";

/**
 * 아래쪽 섹션 마운트 게이트 — 첫 방문의 첫 화면에 섹션 데이터 요청이 한꺼번에 몰리지 않게.
 *
 * - 화면에서 약 1200px 안으로 가까워지면 바로 마운트한다(그때 섹션의 useQuery가 발사된다).
 * - LazyMountProvider의 `backgroundActive`가 켜지면(첫 화면 데이터가 온 뒤) 브라우저가 한가할 때
 *   문서 순서대로 하나씩 미리 마운트한다. 이때 진행 중인 요청이 `maxConcurrent`(기본 2) 이상이면 기다린다.
 * - 주소에 #해시가 있거나(계산기·학교 상세에서 돌아옴) 섹션 탭을 누르면 전부 바로 마운트한다 —
 *   위 섹션이 뒤늦게 늘어나 목표 위치가 밀리지 않게.
 * 마운트 전에는 같은 id를 가진 자리 표시만 두어 섹션 탭·앵커가 그대로 동작한다.
 * 한 번 마운트한 섹션은 다시 숨기지 않는다. 표시되는 숫자는 바뀌지 않고 요청 순서만 바뀐다.
 */

type Entry = {
  el: HTMLElement | null;
  mounted: boolean;
  mount: () => void;
};

type LazyMountApi = {
  register: (key: symbol, entry: Entry) => void;
  unregister: (key: symbol) => void;
  /** 등록된 섹션을 모두 바로 마운트한다(섹션 탭 점프·앵커 복귀). */
  mountAll: () => void;
  isForced: () => boolean;
};

const LazyMountContext = createContext<LazyMountApi | null>(null);

type IdleHandle = { cancel: () => void };

function onIdle(cb: () => void, delayMs = 0): IdleHandle {
  if (typeof window === "undefined") return { cancel: () => {} };
  let idleId: number | null = null;
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(cb, { timeout: 2000 });
    } else {
      // Safari: requestIdleCallback 없음
      idleId = window.setTimeout(cb, 120);
    }
  }, delayMs);
  return {
    cancel: () => {
      window.clearTimeout(timer);
      if (idleId == null) return;
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
    },
  };
}

/** 문서 순서(위→아래) 비교 */
function byDocumentOrder(a: Entry, b: Entry): number {
  if (!a.el || !b.el) return 0;
  const pos = a.el.compareDocumentPosition(b.el);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function initialForced(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hash.length > 1;
}

export function LazyMountProvider({
  children,
  backgroundActive,
  maxConcurrent = 2,
}: {
  children: ReactNode;
  /** 켜지면 한가할 때 남은 섹션을 순서대로 미리 마운트한다(첫 화면 데이터 도착 후). */
  backgroundActive: boolean;
  /** 백그라운드 마운트 중 동시에 진행할 요청 수 상한 */
  maxConcurrent?: number;
}) {
  const queryClient = useQueryClient();
  const entries = useRef(new Map<symbol, Entry>());
  const forced = useRef<boolean | null>(null);
  const kickRef = useRef<() => void>(() => {});

  const api = useMemo<LazyMountApi>(() => {
    const isForced = () => {
      if (forced.current == null) forced.current = initialForced();
      return forced.current;
    };
    return {
      register: (key, entry) => {
        entries.current.set(key, entry);
        if (isForced()) entry.mount();
        else kickRef.current();
      },
      unregister: (key) => {
        entries.current.delete(key);
      },
      mountAll: () => {
        forced.current = true;
        for (const e of entries.current.values()) if (!e.mounted) e.mount();
      },
      isForced,
    };
  }, []);

  useEffect(() => {
    if (!backgroundActive) {
      kickRef.current = () => {};
      return;
    }
    let cancelled = false;
    let handle: IdleHandle | null = null;
    let waitingForFetch = false;

    const nextPending = () =>
      [...entries.current.values()].filter((e) => !e.mounted && e.el).sort(byDocumentOrder)[0];

    const schedule = (delayMs: number) => {
      if (cancelled || handle) return;
      handle = onIdle(() => {
        handle = null;
        tick();
      }, delayMs);
    };

    const tick = () => {
      if (cancelled) return;
      const next = nextPending();
      if (!next) return;
      if (queryClient.isFetching() >= maxConcurrent) {
        waitingForFetch = true;
        return;
      }
      next.mount();
      // 방금 마운트한 섹션의 요청이 시작될 틈을 두고 다음 것을 본다.
      schedule(150);
    };

    kickRef.current = () => schedule(0);
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (!waitingForFetch) return;
      if (queryClient.isFetching() >= maxConcurrent) return;
      waitingForFetch = false;
      schedule(0);
    });
    schedule(0);

    return () => {
      cancelled = true;
      handle?.cancel();
      unsubscribe();
      kickRef.current = () => {};
    };
  }, [backgroundActive, maxConcurrent, queryClient]);

  return <LazyMountContext.Provider value={api}>{children}</LazyMountContext.Provider>;
}

/** 섹션 탭 점프 등에서 남은 섹션을 한 번에 마운트할 때 */
export function useMountAllLazy(): () => void {
  const api = useContext(LazyMountContext);
  return useCallback(() => api?.mountAll(), [api]);
}

export function LazyMountWhenNear({
  id,
  title,
  children,
  rootMargin = "1200px 0px",
  placeholderMinHeight = 200,
}: {
  /** 마운트 전 자리 표시에 붙일 id — 섹션 탭·앵커가 찾을 수 있게 섹션과 같은 id */
  id?: string;
  /** 마운트 전 자리(섹션 로딩)에 보일 섹션 제목 */
  title?: string;
  children: ReactNode;
  rootMargin?: string;
  placeholderMinHeight?: number;
}) {
  const api = useContext(LazyMountContext);
  const [mounted, setMounted] = useState(() => api?.isForced() ?? false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<symbol | null>(null);
  if (keyRef.current == null) keyRef.current = Symbol(id ?? "lazy-section");

  useEffect(() => {
    if (mounted) return;
    const el = placeholderRef.current;
    if (!el) return;
    const key = keyRef.current!;
    const entry: Entry = { el, mounted: false, mount: () => {} };
    const mount = () => {
      entry.mounted = true;
      setMounted(true);
    };
    entry.mount = mount;
    api?.register(key, entry);

    if (typeof IntersectionObserver === "undefined") {
      mount();
      return () => api?.unregister(key);
    }
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) mount();
      },
      { rootMargin },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      api?.unregister(key);
    };
  }, [api, mounted, rootMargin]);

  if (mounted) return <>{children}</>;
  return (
    <div ref={placeholderRef} id={id} data-lazy-placeholder="">
      <LabSectionLoading title={title} minHeight={placeholderMinHeight} />
    </div>
  );
}

/**
 * #해시로 들어왔을 때(계산기·학교 상세에서 돌아옴) 목표 섹션이 실제로 마운트되고 자리를 잡은 뒤 스크롤한다.
 * - 자리 표시(data-lazy-placeholder)나 청크 로딩 중인 자리는 건너뛰고, 진짜 섹션이 생길 때까지 기다린다.
 * - 스크롤한 뒤에도 위 섹션이 데이터를 받아 늘어나면 목표가 밀리므로, 잠시(settleMs) 위치를 다시 맞춘다.
 * - 사용자가 직접 스크롤·터치·키 입력·클릭을 하면 바로 멈춘다 — 목표 섹션을 기다리는 동안에도(늦게 떠서 끌려가지 않게).
 * 반환값은 정리 함수(useEffect cleanup).
 */
export function scrollToSectionWhenReady(
  elementId: string,
  {
    timeoutMs = 15_000,
    settleMs = 2_500,
    onScrolled,
  }: { timeoutMs?: number; settleMs?: number; onScrolled?: () => void } = {},
): () => void {
  if (typeof window === "undefined") return () => {};
  const started = performance.now();
  let stopped = false;
  let scrolledAt = 0;
  let lastAdjustAt = 0;
  let wantedTop: number | null = null;
  let timer: number | null = null;
  let raf: number | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer != null) window.clearTimeout(timer);
    if (raf != null) window.cancelAnimationFrame(raf);
    for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, stop, true);
  };

  const findReady = (): HTMLElement | null => {
    const el = document.getElementById(elementId);
    if (!el || el.hasAttribute("data-lazy-placeholder")) return null;
    return el;
  };

  const tick = () => {
    timer = null;
    if (stopped) return;
    const now = performance.now();
    const el = findReady();
    if (!el) {
      if (now - started > timeoutMs) return stop();
      timer = window.setTimeout(tick, 100);
      return;
    }
    if (wantedTop == null) {
      // 레이아웃이 한 번 끝난 다음 프레임에 스크롤
      raf = window.requestAnimationFrame(() => {
        raf = null;
        if (stopped) return;
        el.scrollIntoView({ behavior: "auto", block: "start" });
        wantedTop = el.getBoundingClientRect().top;
        scrolledAt = lastAdjustAt = performance.now();
        onScrolled?.();
        timer = window.setTimeout(tick, 100);
      });
      return;
    }
    if (Math.abs(el.getBoundingClientRect().top - wantedTop) > 4) {
      el.scrollIntoView({ behavior: "auto", block: "start" });
      lastAdjustAt = now;
    }
    // 마지막으로 맞춘 뒤 settleMs 동안 움직임이 없으면 끝(최대 3배까지만)
    if (now - lastAdjustAt > settleMs || now - scrolledAt > settleMs * 3) return stop();
    timer = window.setTimeout(tick, 100);
  };

  // 기다리는 동안부터 사용자 조작을 본다 — 먼저 움직였으면 나중에 섹션이 떠도 끌고 가지 않는다.
  for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });
  tick();
  return stop;
}

// "scroll"은 넣지 않는다 — 우리가 맞추는 scrollIntoView·스크롤 고정(scroll anchoring)도 scroll을 내므로 사용자 조작과 구분이 안 된다.
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"] as const;
