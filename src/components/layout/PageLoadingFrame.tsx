import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSectionLoading } from "@/components/ui/LabLoading";

export type PageLoadingSection = {
  /** 섹션 제목 — 없으면 제목 없는 카드 */
  title?: string;
  /** 없으면 "{title} 불러오는 중" */
  label?: string;
  minHeight?: number;
};

/**
 * 페이지를 아직 그릴 수 없을 때(경로 Suspense 자리 등) — 회색 상자나 빈 화면 대신
 * 페이지 제목과 섹션 틀을 먼저 그리고, 섹션마다 안에서 "○○ 불러오는 중"을 보인다.
 */
export function PageLoadingFrame({
  title,
  backHref,
  sections,
  shellClassName = PAGE_SHELL,
}: {
  title: string;
  /** 있으면 제목 왼쪽 뒤로가기 */
  backHref?: string;
  sections: PageLoadingSection[];
  shellClassName?: string;
}) {
  return (
    <div className={shellClassName} aria-busy="true">
      <PageHeader
        leading={backHref ? <BackLink fallback={backHref} compact hideLabel /> : undefined}
        title={title}
        titleClassName="detail-page-title"
        showDivider={false}
      />
      {sections.map((s, i) => (
        <LabSectionLoading key={`${s.title ?? ""}-${i}`} title={s.title} label={s.label} minHeight={s.minHeight} />
      ))}
    </div>
  );
}
