import type { Metadata } from "next";
import { Suspense } from "react";
import { PriceMovesPage } from "@/components/market/PriceMovesPage";

export const metadata: Metadata = {
  title: "신고가 · 하락 거래 - 집랩",
  description:
    "전국·시도·시군구별 아파트 신고가와 이전 최고가 대비 10% 이상 하락한 거래를 기간별로 모아 봅니다. 직전 최고가와 그 시점, 변화 금액·변화율을 함께 보여 줍니다.",
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
        <PriceMovesPage />
      </Suspense>
    </main>
  );
}
