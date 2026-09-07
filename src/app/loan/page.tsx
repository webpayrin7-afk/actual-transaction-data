import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/ComingSoonPage";

export const metadata: Metadata = {
  title: "대출계산기 - 아파트 데이터랩",
  description: "주택담보·전세자금 대출 상환 계산기",
};

export default function Page() {
  return (
    <main className="flex-1">
      <ComingSoonPage
        title="대출계산기"
        description="대출 금액·기간·금리로 월 상환액과 이자를 빠르게 계산할 수 있는 도구입니다."
      />
    </main>
  );
}
