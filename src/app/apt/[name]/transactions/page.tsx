import type { Metadata } from "next";
import { AptTransactionsPage } from "@/components/apt/AptTransactionsPage";
import { getRegion } from "@/lib/constants/regions";

type PageProps = {
  params: Promise<{ name: string }>;
  searchParams: Promise<{
    region?: string;
    gu?: string;
    area?: string;
    type?: string;
    period?: string;
    year?: string;
  }>;
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
    title: `${aptName} 거래내역${region ? ` - ${region.name}` : ""}`,
    description: `${aptName} 매매·전세·월세 거래내역`,
  };
}

export default async function AptTransactionsRoute({
  params,
  searchParams,
}: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;
  const initialAreaKey = sp.area?.trim() || undefined;
  const initialType = sp.type?.trim() || undefined;
  // Canonical filter is `year`. Legacy `period=1y|3y|5y|all` is ignored
  // (not remapped to a rolling window) so 전체년도 remains unbounded history.
  const initialYear = sp.year?.trim() || undefined;

  return (
    <main className="flex-1">
      <AptTransactionsPage
        aptName={aptName}
        regionSlug={regionSlug}
        gu={gu}
        initialAreaKey={initialAreaKey}
        initialType={initialType}
        initialYear={initialYear}
      />
    </main>
  );
}
