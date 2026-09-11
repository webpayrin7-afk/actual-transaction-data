import type { Metadata } from "next";
import { Suspense } from "react";
import { LoanCalculator } from "@/components/loan/LoanCalculator";

export const metadata: Metadata = {
  title: "대출 한도·이자 계산기 | 아파트 데이터랩",
  description:
    "LTV·DSR·DTI 기반 대출 한도와 월 상환액·총이자를 계산하고, 서울시 협력자금 실행금리를 확인하세요. 시중은행 주택담보대출 공시금리 비교가 아닙니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense fallback={null}>
        <LoanCalculator />
      </Suspense>
    </main>
  );
}
