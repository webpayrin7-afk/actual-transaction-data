"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";

const EASE = "duration-200 ease-out";
const COMPACT_SCROLL_Y = 12;

/**
 * Mobile home navigation — 2-row expanded → 5-col compact morph.
 * Sticky under SiteHeader; rendered outside PAGE_SHELL.
 *
 * Expanded:
 *   [오늘 ~35%] [지도로 찾기 ~65%]
 *   [단지] [지역] [시장]
 * Compact:
 *   [오늘][지도][단지][지역][시장]
 */
export function HomeNavigation() {
  const pathname = usePathname();
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setCompact(window.scrollY > COMPACT_SCROLL_Y);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <nav
      aria-label="주요 탐색"
      data-mode={compact ? "compact" : "expanded"}
      className={[
        // Match page bg — no gray “tray”; tiles provide contrast.
        "sticky z-40 border-b border-slate-200/40 bg-[color:var(--lab-bg)] sm:hidden",
        `transition-[padding,border-color] ${EASE}`,
        compact ? "px-2 py-1.5" : "px-3 py-2",
      ].join(" ")}
      style={{ top: "var(--site-header-height, 52px)" }}
    >
      <div
        className={[
          "mx-auto grid w-full max-w-[1440px]",
          `transition-[gap] ${EASE}`,
          compact
            ? "grid-cols-5 gap-1"
            : // 6 tracks → row1 2+4 (~33/67≈35/65), row2 three equal spans of 2
              "grid-cols-6 grid-rows-2 gap-1.5",
        ].join(" ")}
      >
        {HOME_QUICK_NAV.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          const disabled = !item.href || Boolean(item.disabled);

          const placement = compact
            ? ""
            : item.id === "market"
              ? "col-span-2 col-start-1 row-start-1"
              : item.id === "map"
                ? "col-span-4 col-start-3 row-start-1"
                : item.id === "complexes"
                  ? "col-span-2 col-start-1 row-start-2"
                  : item.id === "regions"
                    ? "col-span-2 col-start-3 row-start-2"
                    : "col-span-2 col-start-5 row-start-2";

          const tone = disabled
            ? "cursor-not-allowed border-slate-200/50 bg-white/70 text-slate-400"
            : active
              ? "border-teal-100 bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
              : "border-slate-200/70 bg-white text-[color:var(--lab-navy-900)]";

          const shape = compact
            ? "min-h-[52px] flex-col gap-0.5 rounded-xl px-0.5 py-1"
            : "min-h-[44px] flex-row gap-1.5 rounded-xl px-2.5 py-2";

          const className = [
            "flex min-w-0 items-center justify-center border",
            `transition-[min-height,padding,gap,border-radius,background-color,color,border-color] ${EASE}`,
            tone,
            shape,
            placement,
          ].join(" ");

          const label = compact ? item.shortLabel : item.label;
          const iconCls = compact
            ? "h-[15px] w-[15px] stroke-[1.75]"
            : "h-[16px] w-[16px] stroke-[1.75]";
          const labelCls = [
            "font-semibold leading-tight",
            `transition-[font-size] ${EASE}`,
            compact
              ? "max-w-full truncate text-center text-[10px]"
              : "truncate text-[12px]",
          ].join(" ");

          const body = (
            <>
              <span
                className={
                  compact && active
                    ? "inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/80"
                    : "inline-flex shrink-0"
                }
              >
                <Icon className={iconCls} aria-hidden />
              </span>
              <span className={labelCls}>{label}</span>
            </>
          );

          if (disabled) {
            return (
              <div
                key={item.id}
                className={className}
                aria-disabled="true"
                title={item.disabledHint ?? "준비중"}
              >
                {body}
              </div>
            );
          }

          return (
            <Link
              key={item.id}
              href={item.href!}
              aria-current={active ? "page" : undefined}
              className={`${className} active:scale-[0.99]`}
            >
              {body}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
