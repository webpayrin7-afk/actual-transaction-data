import type { Metadata } from "next";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";

export const metadata: Metadata = {
  title: "부동산 계산 도구 | 아파트 데이터랩",
  description:
    "대출 한도와 이자를 계산하고, 서울시 협력자금 실행금리를 확인하는 대출 계산기를 이용하세요.",
};

export default function Page() {
  return (
    <main className="flex-1">
      <div className={PAGE_SHELL}>
        <PageHeader
          title="부동산 계산 도구"
          titleClassName="detail-page-title"
          description="완성된 계산 기능을 이용하세요. 대출 한도, 이자 계산, 서울시 협력자금 금리 정보를 확인할 수 있습니다."
        />

        <LabSection title="계산기">
          <ul className={LAB_LIST}>
            <LabListRow
              href="/loan"
              title="대출 계산기"
              meta="대출 한도와 이자를 계산하고, 서울시 협력자금 실행금리를 확인하세요."
            />
          </ul>
        </LabSection>
      </div>
    </main>
  );
}
