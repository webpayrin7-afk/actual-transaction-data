import type { Metadata } from "next";
import { MarketHome } from "@/components/market/MarketHome";

export const metadata: Metadata = {
  title: "오늘의 아파트 시장 - 집랩",
  description:
    "오늘의 아파트 실거래와 신고가, 하락거래, 거래량 변화를 한눈에 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <MarketHome />
    </main>
  );
}
