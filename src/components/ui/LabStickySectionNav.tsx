"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LabStickySection = { id: string; label: string };

/** Exposed so in-page scroll targets can clear the bar: scroll-mt-[calc(var(--site-header-height)+var(--lab-sticky-nav-height,0px)+…)]. */
export const LAB_STICKY_NAV_HEIGHT_VAR = "--lab-sticky-nav-height";
const SHOW_SLACK_PX = 4;
const HIDE_SLACK_PX = 32;

function siteHeaderHeight(): number {
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  return header ? Math.max(0, Math.round(header.getBoundingClientRect().height)) : 0;
}

/**
 * 긴 페이지용 스티키 섹션 탭 (policy §12.2). `anchor`가 사이트 헤더 아래로 지나가면
 * 나타나고, 현재 렌더된 섹션만 탭으로 보여 준다. 선택 탭은 채움 pill.
 */
export function LabStickySectionNav({
  anchor,
  sections,
  title,
  subtitle,
  ariaLabel,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  sections: readonly LabStickySection[];
  title: string;
  subtitle?: string;
  ariaLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");
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

      const ids = sections.map((s) => s.id).filter((id) => document.getElementById(id));
      setPresent((prev) => (prev.join() === ids.join() ? prev : ids));

      const line = top + (barRef.current?.offsetHeight ?? 0) + 24;
      let current: string = ids[0] ?? sections[0]?.id ?? "";
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
  }, [anchor, sections]);

  useEffect(() => {
    const root = document.documentElement;
    const h = visible ? barRef.current?.offsetHeight ?? 0 : 0;
    root.style.setProperty(LAB_STICKY_NAV_HEIGHT_VAR, `${h}px`);
    return () => {
      root.style.removeProperty(LAB_STICKY_NAV_HEIGHT_VAR);
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

  const items = sections.filter((s) => present.includes(s.id));

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
        <nav aria-label={ariaLabel ?? `${title} 섹션`}>
          <div
            ref={tabsRef}
            className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 py-1.5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
            style={{ scrollbarWidth: "none" }}
          >
            {items.map((s) => (
              <button
                key={s.id}
                type="button"
                data-section={s.id}
                aria-current={active === s.id ? "true" : undefined}
                onClick={() => jump(s.id)}
                className={`relative inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-[14px] leading-5 transition-colors before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
                  active === s.id
                    ? "border-[color:color-mix(in_srgb,var(--lab-teal-600)_35%,transparent)] bg-[color:var(--lab-teal-50)] font-semibold text-[color:var(--lab-teal-700)]"
                    : "border-transparent font-medium text-[color:var(--lab-muted)] hover:bg-slate-50 hover:text-[color:var(--lab-navy-950)]"
                }`}
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
