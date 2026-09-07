import type { Metadata } from "next";
import { LoanRateCompare } from "@/components/rates/LoanRateCompare";

export const metadata: Metadata = {
  title: "금리비교 - 아파트 데이터랩",
  description:
    "서울시 시중은행협력자금 취급 은행별 대출·보전 금리를 비교합니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LoanRateCompare />
    </main>
  );
}
