import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketTrendsPage } from "@/components/stats/MarketTrendsPage";

export const metadata: Metadata = {
  title: "아파트 시장 동향 - 집랩",
  description:
    "전국·시도·서울 구별 아파트 매매·전세가격지수, 거래량, 중위 매매가격, 전세가율의 장기 흐름과 전고점 대비 수준을 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <div className="mx-auto max-w-7xl px-4 py-10" aria-hidden>
            <div className="lab-skeleton" />
          </div>
        }
      >
        <MarketTrendsPage />
      </Suspense>
    </main>
  );
}
