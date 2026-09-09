import type { Metadata } from "next";
import { LoanRateCompare } from "@/components/rates/LoanRateCompare";

export const metadata: Metadata = {
  title: "서울시 협력자금 실행금리 | 아파트 데이터랩",
  description:
    "서울시 시중은행협력자금(OA-21098) 취급 은행의 대출·보전 실행 금리입니다. 주택담보대출 공시금리 비교가 아닙니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LoanRateCompare />
    </main>
  );
}
