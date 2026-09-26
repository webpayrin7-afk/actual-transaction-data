"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";
import { isMapHomePath, useMapDockHidden } from "@/lib/map/map-dock";

/** Space the page must leave at the bottom so the last content/footer isn't under the dock. */
export const MOBILE_DOCK_SPACER = "h-[calc(80px+env(safe-area-inset-bottom))] sm:hidden";

/** Scroll distance before the dock may hide, and the minimum delta that counts as a direction. */
const HIDE_AFTER_Y = 80;
const DELTA = 6;
/** After scrolling stops for this long, a hidden dock comes back. */
const IDLE_SHOW_MS = 1000;

/**
 * 모바일 떠 있는 독 (B+ 내비) — 좌우 여백을 둔 캡슐, 아이콘 + 13px 라벨 5개.
 * 아래로 스크롤하면 숨고, 위로 올리거나 스크롤을 멈추고 잠시(1초) 지나면 나타난다.
 * 맨 위·맨 아래에서는 항상 보인다.
 * 지도 첫 화면(/, /map)에서는 지도를 조작하는 동안·단지 카드가 떠 있는 동안 비킨다 (lib/map/map-dock).
 * 데스크톱(≥sm)은 상단 메뉴·사이드바를 쓰므로 숨김.
 */
export function MobileDock() {
  const pathname = usePathname();
  const [scrollHidden, setHidden] = useState(false);
  const mapHidden = useMapDockHidden();
  const onMap = isMapHomePath(pathname);
  const hidden = scrollHidden || (onMap && mapHidden);
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

  return (
    <nav
      aria-label="주요 탐색"
      data-mobile-dock={hidden ? "hidden" : "shown"}
      inert={onMap && hidden ? true : undefined}
      className={[
        "fixed inset-x-4 z-40 sm:hidden",
        "bottom-[calc(env(safe-area-inset-bottom)+12px)]",
        "rounded-2xl border border-[color:var(--lab-border)] bg-white/95 shadow-[0_6px_20px_rgba(15,23,42,0.12)] backdrop-blur",
        "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
        hidden
          ? `translate-y-[calc(100%+24px)] ${onMap ? "pointer-events-none opacity-0" : ""}`
          : "translate-y-0 opacity-100",
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
    </nav>
  );
}
