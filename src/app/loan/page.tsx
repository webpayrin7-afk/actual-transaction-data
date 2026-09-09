import type { Metadata } from "next";
import { Suspense } from "react";
import { LoanCalculator } from "@/components/loan/LoanCalculator";

export const metadata: Metadata = {
  title: "주택담보대출 한도·이자 계산기 | 금리 비교 | 아파트 데이터랩",
  description:
    "주택가격과 소득으로 LTV·DSR 기반 대출 가능 한도를 확인하고, 대출금액·기간·금리에 따른 월 상환액과 총이자, 금리 변화에 따른 부담 차이를 계산해보세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-slate-500 sm:px-6">
            대출·금리 계산기를 불러오는 중…
          </div>
        }
      >
        <LoanCalculator />
      </Suspense>
    </main>
  );
}
