import type { ReactNode } from "react";
import { InfoTip } from "@/components/ui/InfoTip";

/** 독립 섹션 카드 표면 (policy §12.1). */
export const LAB_SECTION_SURFACE = "lab-card detail-card";

/** 섹션 제목 줄: 제목 + (i)팁 왼쪽, 기준·범위 메타 오른쪽. */
export function LabSectionHeader({
  title,
  meta,
  tip,
}: {
  title: string;
  meta?: ReactNode;
  tip?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center">
        <h2 className="detail-section-title">{title}</h2>
        {tip ? <InfoTip aria-label={`${title} 안내`}>{tip}</InfoTip> : null}
      </div>
      {meta ? <p className="detail-meta tabular-nums">{meta}</p> : null}
    </div>
  );
}

export function LabSection({
  id,
  label,
  title,
  meta,
  tip,
  children,
  className = "gap-3",
}: {
  id?: string;
  /** Accessible name when it should differ from the visible title (e.g. "송파구 거래 동향"). */
  label?: string;
  title: string;
  meta?: ReactNode;
  tip?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-label={label ?? title}
      className={`${LAB_SECTION_SURFACE} flex scroll-mt-28 flex-col ${className}`.trim()}
    >
      <LabSectionHeader title={title} meta={meta} tip={tip} />
      {children}
    </section>
  );
}

/** 섹션 안 하위 영역 제목 줄 (h3/h4, 16px). */
export function LabSubsectionHeader({
  title,
  meta,
  tip,
  as: Tag = "h3",
}: {
  title: string;
  meta?: ReactNode;
  tip?: ReactNode;
  as?: "h3" | "h4";
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center">
        <Tag className="detail-subsection-title">{title}</Tag>
        {tip ? <InfoTip aria-label={`${title} 안내`}>{tip}</InfoTip> : null}
      </div>
      {meta ? <div className="detail-meta tabular-nums">{meta}</div> : null}
    </div>
  );
}

/** 섹션 안 하위 영역 사이 구분선 (하위 영역 경계에만 사용). */
export const LAB_SUBSECTION_RULE = "border-t border-[color:var(--lab-border)] pt-4";
