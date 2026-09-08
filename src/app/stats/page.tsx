import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketStatsPage } from "@/components/stats/MarketStatsPage";

export const metadata: Metadata = {
  title: "아파트 시장동향 - 아파트 데이터랩",
  description:
    "일간·주간·월간 아파트 실거래와 거래량, 신고가, 하락거래를 함께 확인하세요. 서울·경기 시장 흐름과 주요 단지를 탐색합니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-slate-500">
            시장동향을 불러오는 중…
          </div>
        }
      >
        <MarketStatsPage />
      </Suspense>
    </main>
  );
}
