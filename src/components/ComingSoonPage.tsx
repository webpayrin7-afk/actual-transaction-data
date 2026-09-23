import Link from "next/link";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";

export function ComingSoonPage({
  title,
  description,
  group = "도구",
}: {
  title: string;
  description: string;
  group?: string;
}) {
  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title={title}
        titleClassName="detail-page-title"
        meta={group}
        description={description}
      />

      <section className="lab-card detail-card">
        <p className="detail-subsection-title">준비 중인 메뉴입니다</p>
        <p className="mt-2 max-w-xl detail-body">
          곧 이 화면에서 바로 확인할 수 있도록 구성할 예정입니다. 지금은 단지·지역
          실거래 조회를 먼저 이용해 주세요.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/complexes"
            className="lab-button lab-button-primary"
          >
            단지별 조회
          </Link>
          <Link
            href="/regions"
            className="lab-button lab-button-secondary"
          >
            지역별 조회
          </Link>
        </div>
      </section>
    </div>
  );
}
