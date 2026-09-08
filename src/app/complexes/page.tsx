import type { Metadata } from "next";
import { ComplexesPage } from "@/components/complexes/ComplexesPage";

export const metadata: Metadata = {
  title: "단지별 조회 - 아파트 데이터랩",
  description:
    "아파트 단지를 검색하고 실거래가·거래 이력을 확인하세요. 최근 조회와 지역으로도 단지를 찾아볼 수 있습니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComplexesPage />
    </main>
  );
}
