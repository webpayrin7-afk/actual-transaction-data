import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoadingFrame } from "@/components/layout/PageLoadingFrame";
import { MarketTrendsPage } from "@/components/stats/MarketTrendsPage";

export const metadata: Metadata = {
  title: "아파트 시장 흐름 - 집랩",
  description:
    "전국·시도·서울 구별 아파트 매매·전세가격지수, 거래량, 중위 매매가격, 전세가율의 장기 흐름과 전고점 대비 수준을 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <PageLoadingFrame
            title="시장 흐름"
            backHref="/market"
            sections={[
              { title: "가격 흐름", minHeight: 420 },
              { title: "실거래 가격", minHeight: 420 },
              { title: "가격대 구성", minHeight: 360 },
              { title: "거래량 흐름", minHeight: 360 },
            ]}
          />
        }
      >
        <MarketTrendsPage />
      </Suspense>
    </main>
  );
}
