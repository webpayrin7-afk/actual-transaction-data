import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export const metadata: Metadata = {
  title: "통계 - 아파트 데이터랩",
  description: "아파트 실거래 일간·주간·월간 시장 통계와 추세 분석",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComingSoonPage
        group="시장 분석"
        title="통계"
        description="거래량·신고가·전월세 흐름을 일/주/월 단위로 한눈에 볼 수 있는 통계 화면입니다."
      />
    </main>
  );
}
