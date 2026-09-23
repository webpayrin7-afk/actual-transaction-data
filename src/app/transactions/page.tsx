import { Suspense } from "react";
import type { Metadata } from "next";
import { TransactionSearchPage } from "@/components/transactions/TransactionSearchPage";
import type { DealType } from "@/types/transaction";

export const metadata: Metadata = {
  title: "실거래 검색 | 집랩",
  description: "지역·단지명·면적·거래 유형·계약월 조건으로 아파트 매매·전월세 실거래를 검색하세요.",
};

type SearchParams = Promise<{
  aptName?: string;
  gu?: string;
  dealType?: string;
}>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const dealType: DealType | "all" =
    sp.dealType === "trade" || sp.dealType === "rent" ? sp.dealType : "all";
  return (
    <main className="flex-1">
      <Suspense fallback={null}>
        <TransactionSearchPage
          initialAptName={sp.aptName ?? ""}
          initialGu={sp.gu ?? "all"}
          initialDealType={dealType}
        />
      </Suspense>
    </main>
  );
}
