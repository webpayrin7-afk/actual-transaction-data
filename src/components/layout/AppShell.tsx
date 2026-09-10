"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, Calculator, GraduationCap, MapPinned, Percent, Search } from "lucide-react";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { BrandLogo } from "@/components/layout/BrandLogo";

const NAV = [
  { href: "/", label: "오늘의 시장", icon: BarChart3, match: (p: string) => p === "/" },
  { href: "/complexes", label: "단지 조회", icon: Building2, match: (p: string) => p.startsWith("/complexes") || p.startsWith("/apt/") },
  { href: "/regions", label: "지역 조회", icon: MapPinned, match: (p: string) => p === "/regions" || p.startsWith("/region/") },
  { href: "/stats", label: "시장 동향", icon: Search, match: (p: string) => p.startsWith("/stats") },
] as const;

const TOOLS = [
  { href: "/school", label: "학군 정보", icon: GraduationCap },
  { href: "/loan", label: "대출계산기", icon: Calculator },
  { href: "/rates", label: "금리비교", icon: Percent },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <Link href="/" className="flex min-h-28 items-center border-b border-slate-100 px-4 py-1.5" aria-label="집랩 홈">
          <BrandLogo priority />
        </Link>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="주요 메뉴">
          {NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return <Link key={item.href} href={item.href} className={`lab-side-link ${active ? "lab-side-link-active" : ""}`}><Icon className="h-[18px] w-[18px]" />{item.label}</Link>;
          })}
          <div className="my-3 border-t border-slate-100" />
          <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Tools</p>
          {TOOLS.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.href);
            return <Link key={item.href} href={item.href} className={`lab-side-link ${active ? "lab-side-link-active" : ""}`}><Icon className="h-[18px] w-[18px]" />{item.label}</Link>;
          })}
        </nav>
        <p className="px-5 pb-5 text-[11px] leading-5 text-slate-400">국토교통부 실거래 기반<br />LAB Series · Real estate research</p>
      </aside>
      <div className="min-w-0 lg:col-start-2">
        <SiteHeader />
        <main>{children}</main>
      </div>
    </div>
  );
}
