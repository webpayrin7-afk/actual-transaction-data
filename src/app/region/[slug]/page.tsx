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
  if (!region) return { title: "아파트 실거래" };
  return {
    title: `${region.name} 아파트 실거래가 | 아파트 실거래`,
    description: `${region.fullName} 아파트 매매·전월세 실거래가 조회`,
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
      <Dashboard
        region={region}
        initialAptName={sp.aptName ?? ""}
        initialGu={sp.gu ?? "all"}
        initialDealType={dealType}
        initialTab={initialTab}
      />
    </main>
  );
}
