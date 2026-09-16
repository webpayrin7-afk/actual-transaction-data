"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";

const ICON_CLS = "h-[22px] w-[22px] stroke-[1.75]";

/**
 * Mobile home top exploration panel — app-style quick actions.
 * Desktop (sm+) is unchanged; this panel is max-sm only.
 */
export function HomeQuickNavPanel({
  className = "",
}: {
  className?: string;
}) {
  const pathname = usePathname();
  const market = HOME_QUICK_NAV[0];
  const map = HOME_QUICK_NAV[1];
  const rest = HOME_QUICK_NAV.slice(2);

  return (
    <nav
      aria-label="주요 탐색"
      className={`sm:hidden ${className}`.trim()}
    >
      <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)] gap-2">
        {/* Left: featured — 오늘의 시장 */}
        <Link
          href={market.href!}
          className={`row-span-2 flex min-h-[148px] flex-col items-center justify-center gap-2.5 rounded-2xl px-3 py-4 transition active:scale-[0.99] ${
            market.match(pathname)
              ? "bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
              : "bg-slate-50 text-[color:var(--lab-navy-900)]"
          }`}
        >
          <market.icon className={ICON_CLS} aria-hidden />
          <span className="text-center text-[13px] font-semibold leading-tight">
            {market.label}
          </span>
        </Link>

        {/* Right top: 지도로 찾기 */}
        {map.href && !map.disabled ? (
          <Link
            href={map.href}
            className="flex min-h-[68px] items-center gap-2.5 rounded-2xl bg-slate-50 px-3.5 text-[color:var(--lab-navy-900)] transition active:scale-[0.99]"
          >
            <map.icon className={ICON_CLS} aria-hidden />
            <span className="text-[13px] font-semibold">{map.label}</span>
          </Link>
        ) : (
          <div
            role="link"
            aria-disabled="true"
            title={map.disabledHint ?? "준비중"}
            className="flex min-h-[68px] cursor-not-allowed items-center gap-2.5 rounded-2xl bg-slate-50/80 px-3.5 text-slate-400"
          >
            <map.icon className={ICON_CLS} aria-hidden />
            <span className="flex flex-col">
              <span className="text-[13px] font-semibold text-slate-500">
                {map.label}
              </span>
              <span className="text-[11px] font-medium text-slate-400">
                {map.disabledHint ?? "준비중"}
              </span>
            </span>
          </div>
        )}

        {/* Right bottom: 3 small tiles */}
        <div className="grid grid-cols-3 gap-2">
          {rest.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            const body = (
              <>
                <Icon className="h-[20px] w-[20px] stroke-[1.75]" aria-hidden />
                <span className="text-center text-[11px] font-semibold leading-tight">
                  {item.label}
                </span>
              </>
            );
            if (!item.href || item.disabled) {
              return (
                <div
                  key={item.id}
                  aria-disabled="true"
                  title={item.disabledHint ?? "준비중"}
                  className="flex min-h-[72px] cursor-not-allowed flex-col items-center justify-center gap-1.5 rounded-2xl bg-slate-50/80 px-1 py-2 text-slate-400"
                >
                  {body}
                </div>
              );
            }
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-2xl px-1 py-2 transition active:scale-[0.99] ${
                  active
                    ? "bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
                    : "bg-slate-50 text-[color:var(--lab-navy-900)]"
                }`}
              >
                {body}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
