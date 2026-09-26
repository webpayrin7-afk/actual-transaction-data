"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";
import { isMapHomePath } from "@/lib/map/map-dock";

/** Space the page must leave at the bottom so the last content/footer isn't under the dock. */
export const MOBILE_DOCK_SPACER = "h-[calc(80px+env(safe-area-inset-bottom))] sm:hidden";

/** Scroll distance before the dock may hide, and the minimum delta that counts as a direction. */
const HIDE_AFTER_Y = 80;
const DELTA = 6;
/** 지도에서 접은 상태 기억 (브라우저) */
const MAP_FOLD_KEY = "ziplab:map-dock-folded:v1";
/** 지도 위 조작(카드·버튼)이 비워 둘 아래 높이 — 펼침: 독(56)+아래 4+틈 8, 접음: 손잡이 */
const MAP_DOCK_SPACE = { open: "68px", folded: "48px" };
/** 이만큼 아래·위로 쓸면 접기·펴기 */
const SWIPE_PX = 24;

/** After scrolling stops for this long, a hidden dock comes back. */
const IDLE_SHOW_MS = 1000;

/**
 * 모바일 떠 있는 독 (B+ 내비) — 좌우 여백을 둔 캡슐, 아이콘 + 13px 라벨 5개.
 * 아래로 스크롤하면 숨고, 위로 올리거나 스크롤을 멈추고 잠시(1초) 지나면 나타난다.
 * 맨 위·맨 아래에서는 항상 보인다.
 * 지도 첫 화면(/, /map)에서는 늘 보인다 (처음 온 사람이 다른 메뉴를 알게) — 대신 조금 더 아래에 붙는다.
 * 데스크톱(≥sm)은 상단 메뉴·사이드바를 쓰므로 숨김.
 */
export function MobileDock() {
  const pathname = usePathname();
  const [scrollHidden, setHidden] = useState(false);
  const onMap = isMapHomePath(pathname);
  // 지도에서는 접었다 펼 수 있다 (기본 펼침)
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(MAP_FOLD_KEY) === "1") setFolded(true);
    } catch {
      /* 저장소를 못 쓰면 펼침 */
    }
  }, []);
  const mapFolded = onMap && folded;
  // 지도 위 카드·버튼이 독 높이를 따라가게 (--map-dock-space)
  useEffect(() => {
    if (!onMap) return;
    const root = document.documentElement;
    root.style.setProperty("--map-dock-space", mapFolded ? MAP_DOCK_SPACE.folded : MAP_DOCK_SPACE.open);
    return () => {
      root.style.removeProperty("--map-dock-space");
    };
  }, [onMap, mapFolded]);
  // 쓸어 접고 펴기 — 독(펼침)을 아래로, 접힌 알약을 위로
  const swipeY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    swipeY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const y0 = swipeY.current;
    swipeY.current = null;
    const y1 = e.changedTouches[0]?.clientY;
    if (y0 == null || y1 == null) return;
    if (!mapFolded && y1 - y0 > SWIPE_PX) toggleFold();
    else if (mapFolded && y0 - y1 > SWIPE_PX) toggleFold();
  };
  const toggleFold = () =>
    setFolded((v) => {
      try {
        window.localStorage.setItem(MAP_FOLD_KEY, v ? "0" : "1");
      } catch {
        /* 기억 못 해도 전환은 된다 */
      }
      return !v;
    });
  // 지도는 스크롤이 없어 늘 보인다
  const hidden = !onMap && scrollHidden;
  const lastY = useRef(0);

  useEffect(() => {
    let raf = 0;
    let idle = 0;
    lastY.current = window.scrollY;
    const update = () => {
      raf = 0;
      const y = window.scrollY;
      const atBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 4;
      const dy = y - lastY.current;
      if (y < HIDE_AFTER_Y || atBottom) setHidden(false);
      else if (dy > DELTA) setHidden(true);
      else if (dy < -DELTA) setHidden(false);
      if (Math.abs(dy) > DELTA) lastY.current = y;
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => setHidden(false), IDLE_SHOW_MS);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(idle);
    };
  }, []);

  // New page → show the dock again (derived during render, no effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setHidden(false);
  }

  // 3D 단지 탐색은 화면 전체를 쓴다 (하단 조작 패널과 겹치지 않게)
  if (pathname.startsWith("/complex-3d")) return null;

  if (mapFolded) {
    // 접힘 — 메뉴 아이콘만 작게 모은 알약 (눌러 펴기 · 위로 쓸어 펴기). 메뉴가 있다는 걸 잊지 않게 아이콘은 남긴다
    return (
      <button
        type="button"
        onClick={toggleFold}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        aria-label="하단 메뉴 펼치기"
        aria-expanded={false}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+6px)] left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1 rounded-full border border-[color:var(--lab-border)] bg-white/95 px-4 pb-2 pt-1.5 shadow-[0_6px_20px_rgba(15,23,42,0.12)] backdrop-blur before:absolute before:-inset-2 before:content-[''] sm:hidden"
      >
        <span className="h-1 w-7 rounded-full bg-[color:var(--lab-navy-950)]/20" aria-hidden />
        <span className="flex items-center gap-3.5" aria-hidden>
          {HOME_QUICK_NAV.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Icon
                key={item.id}
                className={`h-4 w-4 ${active ? "text-[color:var(--lab-brand-primary)]" : "text-[color:var(--lab-muted)]"}`}
                strokeWidth={active ? 2.2 : 1.75}
              />
            );
          })}
        </span>
      </button>
    );
  }

  return (
    <nav
      aria-label="주요 탐색"
      data-mobile-dock={hidden ? "hidden" : "shown"}
      onTouchStart={onMap ? onTouchStart : undefined}
      onTouchEnd={onMap ? onTouchEnd : undefined}
      className={[
        "fixed inset-x-4 z-40 sm:hidden",
        onMap ? "bottom-[calc(env(safe-area-inset-bottom)+4px)]" : "bottom-[calc(env(safe-area-inset-bottom)+12px)]",
        "rounded-2xl border border-[color:var(--lab-border)] bg-white/95 shadow-[0_6px_20px_rgba(15,23,42,0.12)] backdrop-blur",
        "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
        hidden ? "translate-y-[calc(100%+24px)]" : "translate-y-0 opacity-100",
      ].join(" ")}
    >
      <ul className="grid h-14 grid-cols-5">
        {HOME_QUICK_NAV.map((item) => {
          const Icon = item.icon;
          const active = item.match(pathname);
          const disabled = !item.href || Boolean(item.disabled);
          const body = (
            <>
              <Icon className="h-5 w-5 shrink-0" strokeWidth={active ? 2.2 : 1.75} aria-hidden />
              <span className={`text-[13px] leading-4 ${active ? "font-semibold" : "font-medium"}`}>
                {item.shortLabel}
              </span>
            </>
          );
          const cls = `flex h-full flex-col items-center justify-center gap-0.5 rounded-2xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
            active ? "text-[color:var(--lab-brand-primary)]" : "text-[color:var(--lab-muted)]"
          }`;
          return (
            <li key={item.id}>
              {disabled ? (
                <span className={`${cls} opacity-45`} aria-disabled="true">
                  {body}
                </span>
              ) : (
                <Link href={item.href!} aria-current={active ? "page" : undefined} className={cls}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {onMap ? (
        // 접기 손잡이 — 시트처럼 위 가장자리 가운데 짧은 막대 (눌러 접기 · 아래로 쓸어 접기)
        <button
          type="button"
          onClick={toggleFold}
          aria-label="하단 메뉴 접기"
          aria-expanded
          className="absolute left-1/2 top-0 flex h-4 w-16 -translate-x-1/2 items-start justify-center pt-1 before:absolute before:-inset-x-2 before:-top-3 before:bottom-0 before:content-['']"
        >
          <span className="h-1 w-8 rounded-full bg-[color:var(--lab-navy-950)]/20" aria-hidden />
        </button>
      ) : null}
    </nav>
  );
}
