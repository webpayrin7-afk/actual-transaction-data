import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { AptDetailPage, AptDetailSkeleton } from "@/components/apt/AptDetailPage";
import { FetchPreload } from "@/components/apt/AptDetailPreload";
import { AptDetailEnterTransition } from "@/components/apt/AptDetailEnterTransition";
import { getRegion } from "@/lib/constants/regions";
import {
  getComplexDetailV1,
  resolveComplexLawdCodes,
  type ComplexDetailV1,
} from "@/lib/complex-detail/get-complex-detail-v1";
import {
  APT_DETAIL_MONTHS,
  buildAptDetailUrl,
  buildComplexTypesUrl,
} from "@/lib/apt/apt-detail-url";

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
 * 문서(HTML) 요청일 때만 preload 한다. 앱 안 이동(소프트 내비게이션)은 RSC 요청(Sec-Fetch-Dest: empty)이라
 * preload 힌트가 브라우저에서 그대로 실행되면, React Query에 이미 신선한 시세가 있어도 쓸모없는 요청이 한 번 더 나간다.
 * 이때는 JS가 이미 떠 있어 컴포넌트가 곧바로(필요할 때만) 요청하므로 preload 이득도 없다.
 * Sec-Fetch-Dest가 없는 옛 브라우저는 문서 요청으로 본다(preload는 해가 없다).
 */
async function isDocumentRequest(): Promise<boolean> {
  const dest = (await headers()).get("sec-fetch-dest");
  return !dest || dest === "document" || dest === "iframe";
}

/** 단지정보가 오면 평형 공급면적 API도 미리 받게 한다(클라이언트 fetchComplexTypes와 같은 주소). */
async function PreloadComplexTypes({
  complexDetailPromise,
}: {
  complexDetailPromise: Promise<ComplexDetailV1 | null>;
}) {
  const detail = await complexDetailPromise;
  const complexId = detail?.identity?.complexId;
  return complexId ? <FetchPreload href={buildComplexTypesUrl(complexId)} /> : null;
}

export default async function AptPage({ params, searchParams }: PageProps) {
  const { name } = await params;
  const sp = await searchParams;
  const aptName = decodeURIComponent(name);
  const regionSlug = sp.region?.trim() || "seoul-gangnam";
  const gu = sp.gu?.trim() || undefined;
  const initialAreaKey = sp.area?.trim() || undefined;

  // 첫 방문: 브라우저가 JS를 받는 동안 시세 API가 먼저 돌게 HTML <head>에 preload를 넣는다.
  // 주소는 클라이언트 fetchAptDetail과 같은 빌더라 바이트 단위로 같고, fetch()가 이 응답을 그대로 쓴다.
  const documentRequest = await isDocumentRequest();

  // Enrichment is optional and must not block market rendering.
  const region = getRegion(regionSlug);
  // 다구 도시(성남·수원 등)는 ?gu= 로 구를 고르고, 없으면 지역 전체 코드로 찾는다.
  const lawdCodes = resolveComplexLawdCodes(region, gu);
  // 기다리지 않는다 — 셸 HTML(preload 포함)을 먼저 보내고, 단지정보는 준비되는 대로 스트리밍한다.
  const complexDetailPromise: Promise<ComplexDetailV1 | null> = getComplexDetailV1({
    aptName,
    lawdCodes,
  }).catch((err) => {
    console.error("[apt-page] complex detail enrichment failed", err);
    return null;
  });

  return (
    <main className="flex-1 overflow-x-clip">
      {documentRequest ? (
        <FetchPreload
          href={buildAptDetailUrl({ aptName, region: regionSlug, months: APT_DETAIL_MONTHS, gu })}
        />
      ) : null}
      {documentRequest ? (
        <Suspense fallback={null}>
          <PreloadComplexTypes complexDetailPromise={complexDetailPromise} />
        </Suspense>
      ) : null}
      <AptDetailEnterTransition>
        <Suspense fallback={<AptDetailSkeleton aptName={aptName} regionSlug={regionSlug} gu={gu} />}>
          <AptDetailPage
            aptName={aptName}
            regionSlug={regionSlug}
            gu={gu}
            initialAreaKey={initialAreaKey}
            complexDetailPromise={complexDetailPromise}
            initialNearbyTab={sp.nearbyTab}
            initialSchoolLevel={sp.schoolLevel}
          />
        </Suspense>
      </AptDetailEnterTransition>
    </main>
  );
}
