import type { Metadata } from "next";
import { AptTransactionsPage } from "@/components/apt/AptTransactionsPage";
import { getRegion } from "@/lib/constants/regions";
import { permanentRedirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { groupPrimaryNameFor, groupRedirectHref } from "@/lib/complex-group/groups";
import { resolveComplexLawdCodes } from "@/lib/complex-detail/get-complex-detail-v1";

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

function safeDecodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = safeDecodeName(name);
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
  const aptName = safeDecodeName(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;
  const initialAreaKey = sp.area?.trim() || undefined;
  const initialType = sp.type?.trim() || undefined;
  // Canonical filter is `year`. Legacy `period=1y|3y|5y|all` is ignored
  // (not remapped to a rolling window) so 전체년도 remains unbounded history.
  const initialYear = sp.year?.trim() || undefined;
  // 단지 묶음 멤버 URL → 대표 단지 거래내역 URL (308, 쿼리 그대로)
  const db = getDb();
  const primaryName = db
    ? await groupPrimaryNameFor(db, resolveComplexLawdCodes(getRegion(regionSlug), gu), aptName).catch(() => null)
    : null;
  if (primaryName) permanentRedirect(groupRedirectHref(primaryName, "/transactions", sp));

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
