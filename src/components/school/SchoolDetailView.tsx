import type { ReactNode } from "react";
import { AdvancementSection } from "@/components/school/AdvancementSection";
import { SchoolHero } from "@/components/school/SchoolHero";
import { LAB_SECTION_SURFACE, LabSection } from "@/components/ui/LabSection";
import { DataAttribution } from "@/components/ui/DataAttribution";
import type {
  ProductMetric,
  ProductSchoolDetail,
} from "@/lib/school-info/product-school-detail";
import { SCHOOLINFO_HOME_URL } from "@/lib/school-info/schoolinfo-public-url";

/** 2-column status metrics; 5th metric spans full width. */
function StatusMetrics({ items }: { items: ProductMetric[] }) {
  if (!items.length) return null;
  const head = items.slice(0, 4);
  const fifth = items.length >= 5 ? items[4] : null;
  const rest = items.length > 5 ? items.slice(5) : [];

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
      {head.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="detail-label">{m.label}</dt>
          <dd className="mt-0.5 detail-data-value-emphasis tabular-nums">
            {m.value}
          </dd>
        </div>
      ))}
      {fifth ? (
        <div className="col-span-2 min-w-0 border-t border-[color:var(--lab-border)] pt-2.5">
          <dt className="detail-label">{fifth.label}</dt>
          <dd className="mt-0.5 detail-data-value-emphasis tabular-nums">
            {fifth.value}
          </dd>
        </div>
      ) : null}
      {rest.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="detail-label">{m.label}</dt>
          <dd className="mt-0.5 detail-data-value-emphasis tabular-nums">
            {m.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CompactRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}) {
  if (!rows.length) return null;
  return (
    <dl className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-baseline justify-between gap-3"
        >
          <dt className="detail-label shrink-0">
            {r.label}
          </dt>
          <dd className="min-w-0 text-right detail-data-value tabular-nums">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SchoolDetailView({
  detail,
  backHref,
}: {
  detail: ProductSchoolDetail;
  backHref: string;
}) {
  const coreItems = [
    detail.core.students,
    detail.core.classes,
    detail.core.classSize,
    detail.core.teachers,
    detail.core.studentsPerTeacher,
  ].filter((m): m is ProductMetric => Boolean(m?.value));

  // 학교생활: 급식 · 방과후 · 장학 — scholarship is a row group, not a peer section.
  const lifeRows = [
    detail.schoolLife.mealPerStudent,
    detail.schoolLife.afterSchoolPrograms,
    ...(detail.scholarship
      ? [detail.scholarship.total, detail.scholarship.perStudent]
      : []),
  ]
    .filter((m): m is ProductMetric => Boolean(m?.value))
    .map((m) => ({ label: m.label, value: m.value }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <SchoolHero
        name={detail.name}
        kind={detail.kind}
        foundation={detail.foundation}
        coedu={detail.coedu}
        address={detail.address}
        tel={detail.tel}
        homepage={detail.homepage}
        office={detail.office}
        foundedOn={detail.foundedOn}
        backHref={backHref}
      />

      <div className="flex flex-col gap-3.5 px-3 pb-5 pt-3.5 sm:gap-4 sm:px-4 sm:pb-6 sm:pt-4">
        {detail.authHold ? (
          <section className={LAB_SECTION_SURFACE}>
            <p className="detail-body">
              공시 상세를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </section>
        ) : null}

        {!detail.authHold && detail.unresolved ? (
          <section className={LAB_SECTION_SURFACE}>
            <p className="detail-body">
              이 학교의 공시 정보를 찾지 못했습니다.
            </p>
          </section>
        ) : null}

        {!detail.authHold && detail.basicError ? (
          <section className={LAB_SECTION_SURFACE}>
            <p className="detail-body">
              학교 기본정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </section>
        ) : null}

        {/* 1. 학교 현황 — first content card */}
        {coreItems.length > 0 ? (
          <LabSection title="학교 현황">
            <StatusMetrics items={coreItems} />
          </LabSection>
        ) : null}

        {/* 2. 진학/진학·진로 현황 */}
        <AdvancementSection data={detail.advancement} schoolKind={detail.kind} />

        {/* 3. 학교생활 */}
        {lifeRows.length > 0 ? (
          <LabSection title="학교생활">
            <CompactRows rows={lifeRows} />
          </LabSection>
        ) : null}

        {detail.schoolInfoUrl ? (
          <a
            href={detail.schoolInfoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="lab-button lab-button-primary w-full"
          >
            학교알리미에서 보기
          </a>
        ) : null}

        {detail.attribution ? (
          <footer className="mt-1 border-t border-[color:var(--lab-border)] pt-3 sm:mt-1.5 sm:pt-3.5">
            <DataAttribution
              provider="학교알리미"
              organization="교육부"
              context="항목별 공시연도 기준"
              providerHref={SCHOOLINFO_HOME_URL}
            />
          </footer>
        ) : null}
      </div>
    </div>
  );
}
