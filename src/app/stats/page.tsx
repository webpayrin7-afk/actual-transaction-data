import type { Metadata } from "next";
import { MarketStatsPage } from "@/components/stats/MarketStatsPage";

export const metadata: Metadata = {
  title: "아파트 시장 통계 - 아파트 데이터랩",
  description:
    "서울·경기 아파트 거래량, 중위 거래가격, 신고가·하락거래 추이를 일·주·월 단위로 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <MarketStatsPage />
    </main>
  );
}
