"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";

const EASE = "duration-200 ease-out";

/**
 * Single mobile home navigation.
 * Same 5 items morph expanded (asymmetric grid) → compact (5-col row)
 * while the nav itself sticks under SiteHeader.
 */
export function HomeNavigation() {
  const pathname = usePathname();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const headerH = () => {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--site-header-height")
        .trim();
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : 52;
    };

    let io: IntersectionObserver | null = null;
    const connect = () => {
      io?.disconnect();
      io = new IntersectionObserver(
        ([entry]) => {
          const next = !entry.isIntersecting;
          setCompact((prev) => (prev === next ? prev : next));
        },
        {
          root: null,
          rootMargin: `-${headerH() + 1}px 0px 0px 0px`,
          threshold: [0, 1],
        },
      );
      io.observe(sentinel);
    };

    connect();
    const onResize = () => connect();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      io?.disconnect();
    };
  }, []);

  return (
    <>
      <div
        ref={sentinelRef}
        className="pointer-events-none h-px w-full sm:hidden"
        aria-hidden
      />
      <nav
        aria-label="주요 탐색"
        data-mode={compact ? "compact" : "expanded"}
        className={[
          "sticky z-40 -mx-4 border-b bg-white sm:hidden",
          `transition-[padding,border-color] ${EASE}`,
          compact
            ? "border-slate-200/80 px-2 py-1.5"
            : "border-slate-200/50 px-3 pb-2.5 pt-0",
        ].join(" ")}
        style={{ top: "var(--site-header-height, 52px)" }}
      >
        <div
          className={[
            "grid",
            `transition-[gap] ${EASE}`,
            compact
              ? "grid-cols-5 gap-0.5"
              : // 37% featured | 63% right (map + 3 tiles)
                "grid-cols-[minmax(0,0.37fr)_repeat(3,minmax(0,0.21fr))] grid-rows-[auto_auto] gap-1.5",
          ].join(" ")}
        >
          {HOME_QUICK_NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            const disabled = !item.href || Boolean(item.disabled);
            const featured = !compact && item.id === "market";
            const isMap = item.id === "map";

            const placement = compact
              ? ""
              : item.id === "market"
                ? "col-start-1 row-span-2 row-start-1"
                : item.id === "map"
                  ? "col-span-3 col-start-2 row-start-1"
                  : item.id === "complexes"
                    ? "col-start-2 row-start-2"
                    : item.id === "regions"
                      ? "col-start-3 row-start-2"
                      : "col-start-4 row-start-2";

            const tone = disabled
              ? "cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400"
              : active
                ? "border-teal-100/90 bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
                : "border-slate-200/70 bg-[#f3f5f7] text-[color:var(--lab-navy-900)]";

            const shape = compact
              ? "min-h-[56px] flex-col gap-0.5 rounded-xl px-0.5 py-1.5"
              : featured
                ? "min-h-[108px] h-full flex-col gap-1.5 rounded-2xl px-2 py-2.5"
                : isMap
                  ? "min-h-[48px] flex-row gap-2 rounded-2xl px-3"
                  : "min-h-[52px] flex-col gap-1 rounded-2xl px-1 py-1.5";

            const className = [
              "flex min-w-0 items-center justify-center border",
              `transition-[min-height,padding,gap,border-radius,background-color,color,border-color] ${EASE}`,
              tone,
              shape,
              placement,
            ].join(" ");

            const label = compact ? item.shortLabel : item.label;
            const iconCls = compact
              ? "h-[16px] w-[16px] stroke-[1.75]"
              : featured
                ? "h-[18px] w-[18px] stroke-[1.75]"
                : "h-[17px] w-[17px] stroke-[1.75]";
            const labelCls = [
              "text-center font-semibold leading-tight",
              `transition-[font-size] ${EASE}`,
              compact
                ? "max-w-full truncate text-[10px]"
                : featured
                  ? "text-[12px]"
                  : isMap
                    ? "text-[12px]"
                    : "text-[10.5px]",
            ].join(" ");

            const body = (
              <>
                <span
                  className={
                    compact && active
                      ? "inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white/70"
                      : "inline-flex shrink-0"
                  }
                >
                  <Icon className={iconCls} aria-hidden />
                </span>
                <span className={labelCls}>{label}</span>
                {!compact && isMap && disabled ? (
                  <span className="text-[10px] font-medium text-slate-400">
                    {item.disabledHint ?? "준비중"}
                  </span>
                ) : null}
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
    </>
  );
}
