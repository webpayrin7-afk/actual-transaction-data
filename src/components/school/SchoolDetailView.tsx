import { AdvancementSection } from "@/components/school/AdvancementSection";
import { SchoolHero } from "@/components/school/SchoolHero";
import { DETAIL_PAGE_SHELL } from "@/components/layout/PageHeader";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { DataAttribution } from "@/components/ui/DataAttribution";
import type {
  ProductMetric,
  ProductSchoolDetail,
} from "@/lib/school-info/product-school-detail";
import { SCHOOLINFO_HOME_URL } from "@/lib/school-info/schoolinfo-public-url";

/** 360px 2열 박스에서 라벨이 한 줄이 되도록 줄인 표기 (policy §12.5). */
const STAT_LABEL: Record<string, string> = {
  "교원 1인당 학생수": "교원당 학생수",
};

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
  ].filter((m): m is ProductMetric => Boolean(m?.value));

  const notice = detail.authHold
    ? "공시 상세를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요."
    : detail.unresolved
      ? "이 학교의 공시 정보를 찾지 못했습니다."
      : detail.basicError
        ? "학교 기본정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."
        : null;

  return (
    <div className={DETAIL_PAGE_SHELL}>
      <SchoolHero
        name={detail.name}
        kind={detail.kind}
        foundation={detail.foundation}
        coedu={detail.coedu}
        address={detail.address}
        office={detail.office}
        foundedOn={detail.foundedOn}
        tel={detail.tel}
        homepage={detail.homepage}
        backHref={backHref}
      />

      {notice ? <p className="lab-state">{notice}</p> : null}

      {coreItems.length > 0 ? (
        <LabSection title="학교 현황">
          <LabStatTiles
            columns={2}
            items={coreItems.map((m) => ({
              key: m.label,
              label: STAT_LABEL[m.label] ?? m.label,
              value: m.value,
            }))}
          />
        </LabSection>
      ) : null}

      <AdvancementSection data={detail.advancement} schoolKind={detail.kind} />

      {lifeRows.length > 0 ? (
        <LabSection title="학교생활">
          <ul className={LAB_LIST}>
            {lifeRows.map((m) => (
              <LabListRow key={m.label} title={m.label} value={m.value} />
            ))}
          </ul>
        </LabSection>
      ) : null}

      {detail.schoolInfoUrl ? (
        <a
          href={detail.schoolInfoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="lab-button lab-button-secondary w-full"
        >
          학교알리미에서 전체 공시 보기
        </a>
      ) : null}

      {detail.attribution ? (
        <footer className="border-t border-[color:var(--lab-border)] pt-3">
          <DataAttribution
            provider="학교알리미"
            organization="교육부"
            context="항목별 공시연도 기준"
            providerHref={SCHOOLINFO_HOME_URL}
          />
        </footer>
      ) : null}
    </div>
  );
}
