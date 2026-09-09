import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { ALL_REGIONS, getRegion } from "@/lib/constants/regions";
import type { DealType } from "@/types/transaction";

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
  if (!region) return { title: "아파트 데이터랩" };
  return {
    title: `${region.name} 아파트 시장 | 아파트 데이터랩`,
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
  const dealType =
    sp.dealType === "trade" || sp.dealType === "rent"
      ? (sp.dealType as DealType)
      : "all";
  const initialTab =
    sp.tab === "dong" || sp.tab === "stats" || sp.tab === "search"
      ? sp.tab
      : undefined;

  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-slate-500">
            불러오는 중…
          </div>
        }
      >
        <Dashboard
          region={region}
          initialAptName={sp.aptName ?? ""}
          initialGu={sp.gu ?? "all"}
          initialDealType={dealType}
          initialTab={initialTab}
        />
      </Suspense>
    </main>
  );
}
