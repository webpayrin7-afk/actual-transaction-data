import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoadingFrame } from "@/components/layout/PageLoadingFrame";
import { PAGE_SHELL } from "@/components/layout/PageHeader";
import { LoanCalculator } from "@/components/loan/LoanCalculator";

export const metadata: Metadata = {
  title: "대출 한도·이자 계산기 | 아파트 데이터랩",
  description:
    "LTV·DSR·DTI 기반 대출 한도와 월 상환액·총이자를 계산합니다. 금리 정보는 금리정보 메뉴에서 확인하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <Suspense
        fallback={
          <PageLoadingFrame
            title="대출 계산기"
            shellClassName={`${PAGE_SHELL} max-w-3xl overflow-x-hidden`}
            sections={[{ label: "계산기 불러오는 중", minHeight: 480 }]}
          />
        }
      >
        <LoanCalculator />
      </Suspense>
    </main>
  );
}
