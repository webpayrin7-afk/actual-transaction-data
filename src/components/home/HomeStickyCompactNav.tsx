"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HOME_QUICK_NAV } from "@/lib/nav/home-quick-nav";

/**
 * Compact 5-item bar shown under SiteHeader after the quick panel
 * scrolls out of view (mobile home only).
 */
export function HomeStickyCompactNav({
  className = "",
}: {
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="주요 탐색"
      className={`border-b border-slate-200/80 bg-white sm:hidden ${className}`.trim()}
    >
      <ul className="mx-auto flex max-w-7xl items-stretch justify-between gap-0.5 px-2 py-1.5">
        {HOME_QUICK_NAV.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          const inner = (
            <>
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${
                  active
                    ? "bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
                    : "text-slate-500"
                }`}
              >
                <Icon className="h-[18px] w-[18px] stroke-[1.75]" aria-hidden />
              </span>
              <span
                className={`mt-0.5 max-w-[4.5rem] truncate text-center text-[10px] font-semibold leading-tight ${
                  active
                    ? "text-[color:var(--lab-teal-700)]"
                    : "text-slate-600"
                }`}
              >
                {item.shortLabel}
              </span>
            </>
          );

          if (!item.href || item.disabled) {
            return (
              <li key={item.id} className="min-w-0 flex-1">
                <div
                  aria-disabled="true"
                  title={item.disabledHint ?? "준비중"}
                  className="flex cursor-not-allowed flex-col items-center opacity-55"
                >
                  {inner}
                </div>
              </li>
            );
          }

          return (
            <li key={item.id} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="flex flex-col items-center"
              >
                {inner}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
