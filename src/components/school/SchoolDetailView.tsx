import type { ReactNode } from "react";
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

const INFO_LINK =
  "inline-flex min-h-11 items-center break-all font-medium text-[color:var(--lab-brand-primary)] underline-offset-2 hover:underline tabular-nums";

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

  const homepageHref = detail.homepage
    ? detail.homepage.startsWith("http")
      ? detail.homepage
      : `https://${detail.homepage}`
    : null;
  type InfoRow = { label: string; value: ReactNode };
  const basicRows = ([
    detail.address ? { label: "주소", value: detail.address } : null,
    detail.office ? { label: "교육청", value: detail.office } : null,
    detail.foundedOn ? { label: "설립/개교", value: detail.foundedOn } : null,
    detail.tel
      ? {
          label: "전화",
          value: (
            <a href={`tel:${detail.tel.replace(/\s+/g, "")}`} className={INFO_LINK}>
              {detail.tel}
            </a>
          ),
        }
      : null,
    homepageHref
      ? {
          label: "홈페이지",
          value: (
            <a href={homepageHref} target="_blank" rel="noopener noreferrer" className={INFO_LINK}>
              {detail.homepage!.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
            </a>
          ),
        }
      : null,
  ] as Array<InfoRow | null>).filter((r): r is InfoRow => r != null);

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
        backHref={backHref}
      />

      {notice ? <p className="lab-state">{notice}</p> : null}

      {basicRows.length > 0 ? (
        <LabSection title="기본정보">
          <dl className={LAB_LIST}>
            {basicRows.map((r) => (
              <div key={r.label} className="flex min-h-11 items-center justify-between gap-4 py-2">
                <dt className="detail-label shrink-0">{r.label}</dt>
                <dd className="detail-data-value min-w-0 text-right break-words">{r.value}</dd>
              </div>
            ))}
          </dl>
        </LabSection>
      ) : null}

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
