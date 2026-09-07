import type { Metadata } from "next";
import { LoanCalculator } from "@/components/loan/LoanCalculator";

export const metadata: Metadata = {
  title: "대출계산기 - 아파트 데이터랩",
  description:
    "LTV·DSR·DTI를 반영한 주택담보대출 한도 계산기. 규제지역·생애최초·처분조건부 조건 지원.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LoanCalculator />
    </main>
  );
}
