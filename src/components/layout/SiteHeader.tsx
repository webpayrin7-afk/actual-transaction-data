"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2 } from "lucide-react";

const NAV = [
  { href: "/", label: "홈", match: "home" as const },
  { href: "/anyang", label: "지역별 조회", match: "anyang" as const },
  {
    href: "/anyang?gu=%EB%A7%8C%EC%95%88%EA%B5%AC",
    label: "만안구",
    match: "none" as const,
  },
  {
    href: "/anyang?gu=%EB%8F%99%EC%95%88%EA%B5%AC",
    label: "동안구",
    match: "none" as const,
  },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="inline-flex shrink-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white">
            <Building2 className="h-4 w-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-slate-900">
            안양실거래
          </span>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto text-sm">
          {NAV.map((item) => {
            const active =
              (item.match === "home" && pathname === "/") ||
              (item.match === "anyang" && pathname.startsWith("/anyang"));

            return (
              <Link
                key={item.label}
                href={item.href}
                className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium transition ${
                  active
                    ? "bg-teal-50 text-teal-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
