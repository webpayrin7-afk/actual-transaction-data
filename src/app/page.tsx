import type { Metadata } from "next";
import { MarketHome } from "@/components/market/MarketHome";

export const metadata: Metadata = {
  title: "아파트 시장 - 집랩",
  description:
    "오늘 확인된 아파트 실거래의 신고가·하락거래·지역 분포와 국토교통부·금융위원회 등의 주거 정책 발표를 한눈에 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <MarketHome />
    </main>
  );
}
