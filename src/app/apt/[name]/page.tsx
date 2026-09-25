import type { Metadata } from "next";
import { AptDetailPage } from "@/components/apt/AptDetailPage";
import { AptDetailEnterTransition } from "@/components/apt/AptDetailEnterTransition";
import { getRegion, type RegionDef } from "@/lib/constants/regions";
import { getComplexDetailV1 } from "@/lib/complex-detail/get-complex-detail-v1";

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

/**
 * 단지 마스터 조회에 쓸 구 코드.
 * 구가 하나면 그 코드, 여럿이면 ?gu=(예: "수원시 영통구"·"영통구")가 끝나는 구 이름의 코드.
 * 구를 못 정하면 undefined (첫 구 코드로 넘기면 영통·분당 단지가 비거나 장안·수정의 동명 단지로 붙는다).
 */
function lawdCdForGu(region: RegionDef, gu: string | undefined): string | undefined {
  if (region.lawdCodes.length === 1) return region.lawdCodes[0];
  const needle = gu?.trim();
  if (!needle || needle === "all") return undefined;
  return region.districts.find((d) => needle.endsWith(d.name))?.code;
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
  const lawdCd = region ? lawdCdForGu(region, gu) : undefined;
  let complexDetail = null;
  try {
    complexDetail = await getComplexDetailV1({
      aptName,
      lawdCd,
      // 구가 여럿인 시(수원·성남·고양 등)에서 구를 못 정하면 시 전체 구 코드 중 유일한 단지만.
      lawdCodes: lawdCd ? undefined : region?.lawdCodes,
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
