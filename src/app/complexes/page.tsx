import type { Metadata } from "next";
import { ComplexesPage } from "@/components/complexes/ComplexesPage";

export const metadata: Metadata = {
  title: "단지별 조회 - 집랩",
  description:
    "아파트 단지를 검색하고 실거래가·거래 이력을 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComplexesPage />
    </main>
  );
}
