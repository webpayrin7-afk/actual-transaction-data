import type { Metadata } from "next";
import { LoanRateCompare } from "@/components/rates/LoanRateCompare";

export const metadata: Metadata = {
  title: "금리비교 - 아파트 데이터랩",
  description:
    "금융감독원 금융상품통합비교공시 기준 은행·저축은행 주택담보대출·전세자금대출 금리를 비교합니다.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <LoanRateCompare />
    </main>
  );
}
