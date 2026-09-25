import type { Metadata } from "next";
import { AptDetailPage } from "@/components/apt/AptDetailPage";
import { AptDetailEnterTransition } from "@/components/apt/AptDetailEnterTransition";
import { getRegion } from "@/lib/constants/regions";
import { getComplexDetailV1 } from "@/lib/complex-detail/get-complex-detail-v1";
import { matchDistrictLawdCode } from "@/lib/molit/apt";

type PageProps = {
  params: Promise<{ name: string }>;
  searchParams: Promise<{
    region?: string;
    gu?: string;
    area?: string;
    nearbyTab?: string;
    schoolLevel?: string;
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
    title: `${aptName} 단지 상세${region ? ` - ${region.name}` : ""}`,
    description: `${aptName} 시세·거래·대출세금·관리비·단지정보·학군·주변·비교`,
  };
}

export default async function AptPage({ params, searchParams }: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;
  const initialAreaKey = sp.area?.trim() || undefined;

  // Enrichment is optional and must not block market rendering.
  const region = getRegion(regionSlug);
  // 여러 구로 나뉜 시(성남·고양·용인·화성 등)는 ?gu의 구코드로 찾아야 마스터와 맞는다
  const lawdCd = region
    ? (matchDistrictLawdCode(region, gu) ?? region.lawdCodes[0])
    : undefined;
  let complexDetail = null;
  try {
    complexDetail = await getComplexDetailV1({
      aptName,
      lawdCd,
    });
  } catch (err) {
    console.error("[apt-page] complex detail enrichment failed", err);
  }

  return (
    <main className="flex-1 overflow-x-clip">
      <AptDetailEnterTransition>
        <AptDetailPage
          aptName={aptName}
          regionSlug={regionSlug}
          gu={gu}
          initialAreaKey={initialAreaKey}
          complexDetail={complexDetail}
          initialNearbyTab={sp.nearbyTab}
          initialSchoolLevel={sp.schoolLevel}
        />
      </AptDetailEnterTransition>
    </main>
  );
}
