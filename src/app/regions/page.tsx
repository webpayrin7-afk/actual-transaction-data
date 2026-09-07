import type { Metadata } from "next";
import { RegionsPage } from "@/components/regions/RegionsPage";

export const metadata: Metadata = {
  title: "지역별 조회 - 아파트 실거래",
  description: "서울 25개 구, 경기 31개 시·군 아파트 실거래 지역별 조회",
};

export default function Page() {
  return (
    <main className="flex-1">
      <RegionsPage />
    </main>
  );
}
