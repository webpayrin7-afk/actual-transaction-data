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

  return (
    <main className="flex-1">
      <AptTransactionsPage
        aptName={aptName}
        regionSlug={regionSlug}
        gu={gu}
        initialAreaKey={initialAreaKey}
        initialType={initialType}
      />
    </main>
  );
}
