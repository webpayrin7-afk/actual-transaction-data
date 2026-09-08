import type { Metadata } from "next";
import { RegionsPage } from "@/components/regions/RegionsPage";

export const metadata: Metadata = {
  title: "지역 조회 - 아파트 데이터랩",
  description: "서울·경기 지역별 아파트 실거래와 시장 현황을 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <RegionsPage />
    </main>
  );
}
