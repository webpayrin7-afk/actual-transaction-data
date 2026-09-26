import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";

export const metadata: Metadata = {
  title: "부동산 계산 도구 | 아파트 데이터랩",
  description:
    "대출 한도와 이자를 계산하고, 금융감독원 공시 대출 금리를 비교해 보세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <div className={PAGE_SHELL}>
        <PageHeader
          title="부동산 계산 도구"
          titleClassName="detail-page-title"
          description="완성된 계산 기능을 이용하세요. 대출 한도·이자 계산과 금융감독원 공시 대출 금리비교를 이용할 수 있습니다."
        />

        <LabSection title="계산기">
          <ul className={LAB_LIST}>
            <li>
              <Link
                href="/loan"
                className="flex min-h-11 items-center gap-3 py-3 hover:bg-slate-50/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="detail-data-value-emphasis">대출 계산기</p>
                  <p className="detail-meta">
                    대출 한도와 이자를 계산하세요.
                  </p>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-[color:var(--lab-muted)]"
                  aria-hidden
                />
              </Link>
            </li>
            <li>
              <Link
                href="/rates"
                className="flex min-h-11 items-center gap-3 py-3 hover:bg-slate-50/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="detail-data-value-emphasis">대출 금리비교</p>
                  <p className="detail-meta">
                    금융감독원 공시 기준 주택담보대출·전세자금대출 금리를 낮은 순으로 비교하세요.
                  </p>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-[color:var(--lab-muted)]"
                  aria-hidden
                />
              </Link>
            </li>
          </ul>
        </LabSection>
      </div>
    </main>
  );
}
