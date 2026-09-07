import type { Metadata } from "next";
import { AptDetailPage } from "@/components/apt/AptDetailPage";
import { getRegion } from "@/lib/constants/regions";

type PageProps = {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ region?: string; gu?: string }>;
};

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const region = sp.region ? getRegion(sp.region) : undefined;
  return {
    title: `${aptName} 아파트 실거래가 이력${region ? ` - ${region.name}` : ""}`,
    description: `${aptName} 단지 매매 실거래 이력 조회`,
  };
}

export default async function AptPage({ params, searchParams }: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;

  return (
    <main className="flex-1">
      <AptDetailPage aptName={aptName} regionSlug={regionSlug} gu={gu} />
    </main>
  );
}
