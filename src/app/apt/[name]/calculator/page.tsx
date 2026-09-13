import type { Metadata } from "next";
import { AptCalculatorPage } from "@/components/apt/calculator/AptCalculatorPage";
import { getRegion } from "@/lib/constants/regions";

type PageProps = {
  params: Promise<{ name: string }>;
  searchParams: Promise<{
    region?: string;
    gu?: string;
    area?: string;
    price?: string;
    tab?: string;
  }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { name } = await params;
  const aptName = decodeURIComponent(name);
  return {
    title: `${aptName} 대출·세금 계산`,
    description: `${aptName} 매수비용·보유세·대출 추정 계산기`,
  };
}

export default async function AptCalculatorRoute({
  params,
  searchParams,
}: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;
  const initialAreaKey = sp.area?.trim() || undefined;
  const priceRaw = sp.price ? Number(sp.price) : undefined;
  const initialPriceMan =
    priceRaw != null && Number.isFinite(priceRaw) && priceRaw > 0
      ? priceRaw
      : undefined;
  const tabRaw = sp.tab?.trim();
  const initialTab =
    tabRaw === "holding" || tabRaw === "loan" || tabRaw === "purchase"
      ? tabRaw
      : undefined;

  // Validate region exists (soft — page still renders with slug).
  void getRegion(regionSlug);

  return (
    <main className="flex-1">
      <AptCalculatorPage
        aptName={aptName}
        regionSlug={regionSlug}
        gu={gu}
        initialAreaKey={initialAreaKey}
        initialPriceMan={initialPriceMan}
        initialTab={initialTab}
      />
    </main>
  );
}
