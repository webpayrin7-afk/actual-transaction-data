import { Suspense } from "react";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { RegionPageLoadFallback } from "@/components/RegionPageLoadFallback";
import { ALL_REGIONS, getRegion } from "@/lib/constants/regions";

type SearchParams = Promise<{
  aptName?: string;
  gu?: string;
  dealType?: string;
  tab?: string;
}>;

export function generateStaticParams() {
  return ALL_REGIONS.map((r) => ({ slug: r.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const region = getRegion(slug);
  if (!region) return { title: "집랩" };
  return {
    title: `${region.name} 아파트 시장 | 집랩`,
    description: `${region.fullName} 아파트 시장 현황, 새로 확인된 거래, 매매 실거래를 확인하세요.`,
  };
}

export default async function RegionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const region = getRegion(slug);
  if (!region) notFound();

  const sp = await searchParams;
  if (region.slug !== slug) {
    // 행정구역 개편 전 slug·별칭 → 정식 주소로 영구 이동 (쿼리 유지)
    const qs = new URLSearchParams(
      Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"),
    ).toString();
    permanentRedirect(`/region/${region.slug}${qs ? `?${qs}` : ""}`);
  }
  if (sp.tab === "search" || sp.aptName?.trim()) {
    const qs = new URLSearchParams({ region: region.slug });
    if (sp.aptName?.trim()) qs.set("aptName", sp.aptName.trim());
    if (sp.gu && sp.gu !== "all") qs.set("gu", sp.gu);
    if (sp.dealType === "trade" || sp.dealType === "rent") qs.set("dealType", sp.dealType);
    redirect(`/transactions?${qs.toString()}`);
  }
  const initialTab = sp.tab === "dong" || sp.tab === "stats" ? sp.tab : undefined;

  return (
    <main className="flex-1">
      <Suspense fallback={<RegionPageLoadFallback />}>
        <Dashboard region={region} initialTab={initialTab} />
      </Suspense>
    </main>
  );
}
