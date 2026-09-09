import type { Metadata } from "next";
import { LeaderMapPage } from "@/components/leader-map/LeaderMapPage";

export const metadata: Metadata = {
  title: "서울 대장 아파트 지도 - 아파트 데이터랩",
  description:
    "최근 12개월 매매 실거래로 서울 25개 구의 대표 아파트를 지도에서 살펴보세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LeaderMapPage />
    </main>
  );
}
