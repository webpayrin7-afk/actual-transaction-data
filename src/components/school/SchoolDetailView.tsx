import type { ReactNode } from "react";
import Link from "next/link";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import type { Metric, SchoolDetail } from "@/lib/school-info/types";

/** Header subtitle: compact road address for wireframe (서울 · road only). */
function compactAddress(address: string): string {
  let s = address.replace(/^서울특별시\s*/, "서울 ").trim();
  // Drop trailing ", 학교명 (동)" noise from SchoolInfo road strings.
  s = s.replace(/\s*,\s*.*$/, "").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return s;
}

function MetricGrid({ items }: { items: Metric[] }) {
  if (!items.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 sm:gap-x-6">
      {items.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="text-[12px] text-slate-500 sm:text-[13px]">{m.label}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 sm:text-base">
            {m.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function InfoRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}) {
  if (!rows.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0 sm:block sm:border-0 sm:py-0"
        >
          <dt className="shrink-0 text-[13px] text-slate-500">{r.label}</dt>
          <dd className="min-w-0 text-right text-sm font-medium text-slate-900 sm:mt-1 sm:text-left sm:text-[15px]">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export function SchoolDetailView({
  detail,
  backHref,
}: {
  detail: SchoolDetail;
  backHref: string;
}) {
  const headerTitle = detail.foundation
    ? `[${detail.foundation}] ${detail.name}`
    : detail.name;
  const headerAddress = detail.address
    ? compactAddress(detail.address)
    : undefined;

  const coreItems = [
    detail.core.students,
    detail.core.classes,
    detail.core.classSize,
    detail.core.teachers,
    detail.core.studentsPerTeacher,
  ].filter((m): m is Metric => Boolean(m?.value));

  const lifeItems = [
    detail.schoolLife.mealPerStudent,
    detail.schoolLife.afterSchoolPrograms,
  ].filter((m): m is Metric => Boolean(m?.value));

  const scholarshipItems = detail.scholarship
    ? [detail.scholarship.total, detail.scholarship.perStudent].filter(
        (m): m is Metric => Boolean(m?.value),
      )
    : [];

  const basicRows: Array<{ label: string; value: ReactNode }> = [];
  if (detail.foundation) {
    basicRows.push({ label: "설립구분", value: detail.foundation });
  }
  if (detail.address) {
    basicRows.push({ label: "주소", value: detail.address });
  }
  if (detail.tel) {
    basicRows.push({ label: "전화", value: detail.tel });
  }
  if (detail.homepage) {
    const href = detail.homepage.startsWith("http")
      ? detail.homepage
      : `https://${detail.homepage}`;
    basicRows.push({
      label: "홈페이지",
      value: (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
        >
          {homepageLabel(detail.homepage)}
        </a>
      ),
    });
  }
  if (detail.office) {
    basicRows.push({ label: "관할교육청", value: detail.office });
  }
  if (detail.foundedOn) {
    basicRows.push({ label: "설립/개교", value: detail.foundedOn });
  }

  const authHold = !detail.auth.keyPresent;

  return (
    <div className={`${PAGE_SHELL} max-w-3xl`}>
      <PageHeader
        leading={
          <BackLink fallback={backHref} compact hideLabel preferFallback />
        }
        title={headerTitle}
        description={headerAddress}
        compact
      />

      {authHold ? (
        <LabCard className="p-4 sm:p-5">
          <p className="text-sm text-slate-700">
            학교알리미 API 키가 설정되지 않아 공시 상세를 불러올 수 없습니다.
          </p>
        </LabCard>
      ) : null}

      {!authHold &&
      detail.sectionStatus.basic === "error" &&
      !detail.schoolInfoCode ? (
        <LabCard className="p-4 sm:p-5">
          <p className="text-sm text-slate-700">
            학교 기본정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
          </p>
        </LabCard>
      ) : null}

      {coreItems.length > 0 ? (
        <LabCard className="p-4 sm:p-5">
          <LabSectionHeading title="학교 현황" />
          <MetricGrid items={coreItems} />
        </LabCard>
      ) : null}

      {lifeItems.length > 0 ? (
        <LabCard className="p-4 sm:p-5">
          <LabSectionHeading title="학교생활" />
          <MetricGrid items={lifeItems} />
        </LabCard>
      ) : null}

      {detail.advancement &&
      (detail.advancement.graduates?.value ||
        detail.advancement.buckets.length > 0) ? (
        <LabCard className="p-4 sm:p-5">
          <LabSectionHeading title="진학정보" />
          {detail.advancement.graduates?.value ? (
            <p className="mt-3 text-[15px] font-semibold tabular-nums text-slate-900">
              졸업생 {detail.advancement.graduates.value}
            </p>
          ) : null}
          {detail.advancement.buckets.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {detail.advancement.buckets.map((b) => (
                <li
                  key={b.label}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-slate-600">{b.label}</span>
                  <span className="font-medium tabular-nums text-slate-900">
                    {b.count != null
                      ? `${b.count.toLocaleString("ko-KR")}명`
                      : ""}
                    {b.count != null && b.percent != null ? " · " : ""}
                    {b.percent != null ? `${b.percent}%` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </LabCard>
      ) : null}

      {scholarshipItems.length > 0 ? (
        <LabCard className="p-4 sm:p-5">
          <LabSectionHeading title="장학정보" />
          <MetricGrid items={scholarshipItems} />
        </LabCard>
      ) : null}

      {basicRows.length > 0 ? (
        <LabCard className="p-4 sm:p-5">
          <LabSectionHeading title="기본정보" />
          <InfoRows rows={basicRows} />
        </LabCard>
      ) : null}

      <p className="flex items-center justify-center gap-1 text-center text-[12px] text-slate-500">
        <span>{detail.attribution}</span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-0.5">
          출처
          <InfoTip aria-label="학교 상세 출처 안내">
            <p>학교알리미(학교정보공시) OpenAPI 공시 자료를 표시합니다.</p>
            <p className="mt-1">급식·진학 등 공시 필드가 없으면 해당 섹션은 생략합니다.</p>
          </InfoTip>
        </span>
      </p>

      <p className="text-center text-[12px]">
        <Link
          href={backHref}
          className="font-medium text-[color:var(--lab-teal-700)] hover:underline"
        >
          단지 학교 탭으로 돌아가기
        </Link>
      </p>
    </div>
  );
}
