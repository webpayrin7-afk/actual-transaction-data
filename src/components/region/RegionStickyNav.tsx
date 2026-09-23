"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { labUnderlineTabClass } from "@/components/ui/lab";

export const MARKET_SECTIONS = [
  { id: "market-price", label: "시세" },
  { id: "market-dong", label: "동네별" },
  { id: "market-jeonse", label: "전세" },
  { id: "market-trends", label: "거래 동향" },
  { id: "newly-seen-deals", label: "신고가" },
  { id: "region-ranking", label: "랭킹" },
  { id: "market-budget", label: "예산" },
  { id: "market-supply", label: "입주" },
  { id: "market-history", label: "거래 내역" },
] as const;

const NAV_HEIGHT_VAR = "--region-sticky-nav-height";
const SHOW_SLACK_PX = 4;
const HIDE_SLACK_PX = 32;

function siteHeaderHeight(): number {
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  return header ? Math.max(0, Math.round(header.getBoundingClientRect().height)) : 0;
}

/**
 * Fixed compact header for the long 시장 현황 tab: appears once `anchor` scrolls
 * under the site header, with jump links to each rendered section.
 */
export function RegionStickyNav({
  anchor,
  title,
  subtitle,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  title: string;
  subtitle?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string>(MARKET_SECTIONS[0].id);
  const [present, setPresent] = useState<string[]>([]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const jumpingTo = useRef<string | null>(null);

  useEffect(() => {
    let raf = 0;
    let shown = false;
    const update = () => {
      raf = 0;
      const el = anchor.current;
      if (!el) return;
      const top = siteHeaderHeight();
      const anchorTop = el.getBoundingClientRect().top;
      if (!shown && anchorTop <= top - SHOW_SLACK_PX) {
        shown = true;
        setVisible(true);
      } else if (shown && anchorTop >= top + HIDE_SLACK_PX) {
        shown = false;
        setVisible(false);
      }

      const ids = MARKET_SECTIONS.map((s) => s.id).filter((id) => document.getElementById(id));
      setPresent((prev) => (prev.join() === ids.join() ? prev : ids));

      const line = top + (barRef.current?.offsetHeight ?? 0) + 24;
      let current: string = ids[0] ?? MARKET_SECTIONS[0].id;
      for (const id of ids) {
        const node = document.getElementById(id);
        if (node && node.getBoundingClientRect().top <= line) current = id;
      }
      const nearBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (nearBottom && ids.length) current = ids[ids.length - 1]!;
      if (jumpingTo.current) {
        if (current === jumpingTo.current) jumpingTo.current = null;
        else return;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const mo = new MutationObserver(onScroll);
    if (anchor.current?.parentElement) {
      mo.observe(anchor.current.parentElement, { childList: true, subtree: false });
    }
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      mo.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    const root = document.documentElement;
    const h = visible ? barRef.current?.offsetHeight ?? 0 : 0;
    root.style.setProperty(NAV_HEIGHT_VAR, `${h}px`);
    return () => {
      root.style.removeProperty(NAV_HEIGHT_VAR);
    };
  }, [visible]);

  useEffect(() => {
    const tabs = tabsRef.current;
    const btn = tabs?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!tabs || !btn) return;
    const left = btn.offsetLeft - (tabs.clientWidth - btn.offsetWidth) / 2;
    tabs.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [active, visible]);

  const jump = useCallback((id: string) => {
    const targetTop = () => {
      const node = document.getElementById(id);
      if (!node) return null;
      const offset = siteHeaderHeight() + (barRef.current?.offsetHeight ?? 0) + 8;
      return Math.max(0, node.getBoundingClientRect().top + window.scrollY - offset);
    };
    const first = targetTop();
    if (first == null) return;
    jumpingTo.current = id;
    setActive(id);
    window.scrollTo({ top: first, behavior: "smooth" });
    // Sections above may still be loading and grow while we scroll; re-aim once settled.
    let tries = 0;
    const settle = () => {
      const top = targetTop();
      if (top == null || tries >= 4) return;
      tries += 1;
      if (Math.abs(top - window.scrollY) > 4) {
        window.scrollTo({ top, behavior: tries === 1 ? "smooth" : "auto" });
        window.setTimeout(settle, 450);
      }
    };
    window.setTimeout(settle, 700);
  }, []);

  const items = MARKET_SECTIONS.filter((s) => present.includes(s.id));

  return (
    <div
      ref={barRef}
      className={`fixed inset-x-0 z-40 border-b border-[color:var(--lab-border)] bg-white/95 backdrop-blur transition-[opacity,transform] duration-150 ease-out ${
        visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0"
      }`}
      style={{ top: "var(--site-header-height, 0px)" }}
      aria-hidden={!visible}
      {...(!visible ? { inert: true } : {})}
    >
      <div className="mx-auto w-full max-w-[70rem] px-4 sm:px-6 lg:px-8">
        <p className="hidden min-w-0 items-baseline gap-1.5 pt-2 sm:flex">
          <span className="detail-subsection-title truncate">{title}</span>
          {subtitle ? <span className="detail-meta shrink-0">{subtitle}</span> : null}
        </p>
        <nav aria-label={`${title} 시장 현황 섹션`}>
          <div
            ref={tabsRef}
            className="-mx-4 flex gap-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
            style={{ scrollbarWidth: "none" }}
          >
            {items.map((s) => (
              <button
                key={s.id}
                type="button"
                data-section={s.id}
                aria-current={active === s.id ? "true" : undefined}
                onClick={() => jump(s.id)}
                className={labUnderlineTabClass(active === s.id, "shrink-0 whitespace-nowrap")}
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}
