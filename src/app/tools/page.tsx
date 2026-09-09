import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Calculator } from "lucide-react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

export const metadata: Metadata = {
  title: "부동산 계산 도구 | 아파트 데이터랩",
  description:
    "대출 상환액과 금리 차이에 따른 부담을 비교하는 대출·금리 계산기를 이용하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <div className={PAGE_SHELL}>
        <PageHeader
          title="부동산 계산 도구"
          description="완성된 계산 기능을 이용하세요. 대출 상환액과 금리 변화에 따른 부담 차이를 한 화면에서 비교할 수 있습니다."
        />

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link
            href="/loan"
            className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-teal-300 hover:bg-teal-50/40"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
              <Calculator className="h-4 w-4" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-slate-900">
              대출·금리 계산기
            </h2>
            <p className="mt-1 flex-1 text-sm leading-6 text-slate-500">
              대출 상환액과 금리 차이에 따른 부담을 비교해보세요.
            </p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-teal-700">
              이용하기
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        </section>
      </div>
    </main>
  );
}
