import type { Metadata } from "next";
import { Suspense } from "react";
import { LoanCalculator } from "@/components/loan/LoanCalculator";

export const metadata: Metadata = {
  title: "주택담보대출 계산기 · 금리 비교 | 아파트 데이터랩",
  description:
    "대출금액, 금리, 기간과 상환방식을 입력해 월 상환액과 총이자를 계산하고 금리 변화에 따른 부담 차이를 비교합니다.",
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
