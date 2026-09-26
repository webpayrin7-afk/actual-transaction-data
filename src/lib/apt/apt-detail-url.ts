import { APT_API_VERSION } from "@/lib/molit/apt-client";

/**
 * 단지 상세 시세 API 주소 — 서버(page.tsx preload)와 브라우저(fetchAptDetail)가 같은 함수를 쓴다.
 * 브라우저는 preload 응답을 주소가 바이트 단위로 같을 때만 다시 쓰므로 순서(aptName·region·months·gu·v)와
 * 인코딩을 여기 한 곳에서만 정한다.
 */
export function buildAptDetailUrl({
  aptName,
  region,
  months,
  gu,
}: {
  aptName: string;
  region: string;
  months: number;
  gu?: string;
}): string {
  const qs = new URLSearchParams({
    aptName,
    region,
    months: String(months),
  });
  if (gu?.trim()) qs.set("gu", gu.trim());
  qs.set("v", APT_API_VERSION);
  return `/api/apt-detail?${qs.toString()}`;
}

/** 단지 상세 첫 화면이 부르는 기간 — DB 모드는 months와 무관하게 전체 이력을 준다. */
export const APT_DETAIL_MONTHS = 120;

/** 평형 공급면적(타입) API 주소 — fetchComplexTypes와 같은 모양 */
export function buildComplexTypesUrl(complexId: string): string {
  return `/api/complex-types/${complexId}`;
}
