import type { Metadata } from "next";
import { ComplexesPage } from "@/components/complexes/ComplexesPage";

export const metadata: Metadata = {
  title: "단지별 조회 - 아파트 데이터랩",
  description:
    "단지명으로 서울·경기 아파트 매매·전월세 실거래 이력과 시세를 조회합니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComplexesPage />
    </main>
  );
}
