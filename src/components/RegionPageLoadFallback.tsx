"use client";

import { PageLoadingFrame } from "@/components/layout/PageLoadingFrame";

/** 지역 상세가 아직 그려지기 전(경로 Suspense) — 지역 이름과 섹션 틀을 먼저 보인다. */
export function RegionPageLoadFallback({ regionName }: { regionName: string }) {
  return (
    <PageLoadingFrame
      title={regionName}
      backHref="/regions"
      sections={[{ title: "시장 현황", minHeight: 480 }]}
    />
  );
}
