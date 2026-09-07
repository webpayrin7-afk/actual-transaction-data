"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2 } from "lucide-react";

const NAV = [
  {
    href: "/",
    label: "단지별 조회",
    match: (pathname: string) =>
      pathname === "/" || pathname.startsWith("/apt/"),
  },
  {
    href: "/regions",
    label: "지역별 조회",
    match: (pathname: string) =>
      pathname === "/regions" || pathname.startsWith("/region/"),
  },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-0 px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center">
          <Link href="/" className="inline-flex shrink-0 items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white">
              <Building2 className="h-4 w-4" />
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              아파트 데이터랩
            </span>
          </Link>
        </div>

        <nav className="-mx-1 flex items-center gap-1 overflow-x-auto pb-2.5 text-sm">
          {NAV.map((item) => {
            const active = item.match(pathname);

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
