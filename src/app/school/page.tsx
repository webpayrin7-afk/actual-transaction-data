import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export const metadata: Metadata = {
  title: "학군 정보 - 아파트 데이터랩",
  description: "단지·지역 주변 학군 정보",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComingSoonPage
        title="학군 정보"
        description="관심 단지와 지역 주변의 학교·학군 정보를 실거래 조회와 함께 참고할 수 있게 준비 중입니다."
      />
    </main>
  );
}
