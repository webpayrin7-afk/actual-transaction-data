import type { ReactNode } from "react";
import Link from "next/link";
import { BackLink } from "@/components/layout/BackLink";
import { InfoTip } from "@/components/ui/InfoTip";
import type { Metric, SchoolDetail } from "@/lib/school-info/types";

/** Header subtitle: compact road address (서울 · road only). */
function compactAddress(address: string): string {
  let s = address.replace(/^서울특별시\s*/, "서울 ").trim();
  s = s.replace(/\s*,\s*.*$/, "").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return s;
}

function homepageLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold tracking-tight text-slate-800">
      {children}
    </h2>
  );
}

/** 2-column status metrics; 5th metric spans full width. */
function StatusMetrics({ items }: { items: Metric[] }) {
  if (!items.length) return null;
  const head = items.slice(0, 4);
  const fifth = items.length >= 5 ? items[4] : null;
  const rest = items.length > 5 ? items.slice(5) : [];

  return (
    <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
      {head.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="text-[11px] leading-4 text-slate-500">{m.label}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold tabular-nums leading-5 text-slate-900">
            {m.value}
          </dd>
        </div>
      ))}
      {fifth ? (
        <div className="col-span-2 min-w-0 border-t border-slate-100 pt-2.5">
          <dt className="text-[11px] leading-4 text-slate-500">{fifth.label}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold tabular-nums leading-5 text-slate-900">
            {fifth.value}
          </dd>
        </div>
      ) : null}
      {rest.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="text-[11px] leading-4 text-slate-500">{m.label}</dt>
          <dd className="mt-0.5 text-[15px] font-semibold tabular-nums leading-5 text-slate-900">
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
    <dl className="mt-2 space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-baseline justify-between gap-3"
        >
          <dt className="shrink-0 text-[12px] leading-5 text-slate-500">
            {r.label}
          </dt>
          <dd className="min-w-0 text-right text-[13px] font-semibold tabular-nums leading-5 text-slate-900">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BasicRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode; long?: boolean }>;
}) {
  if (!rows.length) return null;
  return (
    <dl className="mt-2 space-y-2">
      {rows.map((r) => (
        <div
          key={r.label}
          className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-start gap-x-3"
        >
          <dt className="shrink-0 text-[12px] leading-5 text-slate-500">
            {r.label}
          </dt>
          <dd
            className={`min-w-0 text-[13px] font-medium leading-5 text-slate-900 ${
              r.long ? "text-left break-words" : ""
            }`}
          >
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
  detail: SchoolDetail;
  backHref: string;
}) {
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

  const lifeRows = [
    detail.schoolLife.mealPerStudent,
    detail.schoolLife.afterSchoolPrograms,
  ]
    .filter((m): m is Metric => Boolean(m?.value))
    .map((m) => ({ label: m.label, value: m.value }));

  const scholarshipRows = detail.scholarship
    ? [detail.scholarship.total, detail.scholarship.perStudent]
        .filter((m): m is Metric => Boolean(m?.value))
        .map((m) => ({ label: m.label, value: m.value }))
    : [];

  const hasAdvancement = Boolean(
    detail.advancement &&
      (detail.advancement.graduates?.value ||
        detail.advancement.buckets.length > 0),
  );

  const basicRows: Array<{ label: string; value: ReactNode; long?: boolean }> =
    [];
  if (detail.foundation) {
    basicRows.push({ label: "설립구분", value: detail.foundation });
  }
  if (detail.address) {
    basicRows.push({ label: "주소", value: detail.address, long: true });
  }
  if (detail.tel) {
    basicRows.push({
      label: "전화",
      value: (
        <a
          href={`tel:${detail.tel.replace(/\s+/g, "")}`}
          className="text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
        >
          {detail.tel}
        </a>
      ),
    });
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
          className="break-all text-[color:var(--lab-teal-700)] underline-offset-2 hover:underline"
        >
          {homepageLabel(detail.homepage)}
        </a>
      ),
      long: true,
    });
  }
  if (detail.office) {
    basicRows.push({ label: "관할교육청", value: detail.office, long: true });
  }
  if (detail.foundedOn) {
    basicRows.push({ label: "설립/개교", value: detail.foundedOn });
  }

  const authHold = !detail.auth.keyPresent;
  const hasSecondary =
    lifeRows.length > 0 ||
    scholarshipRows.length > 0 ||
    basicRows.length > 0 ||
    hasAdvancement;

  let secondaryStarted = false;
  function secondaryBlock(node: ReactNode) {
    const withDivider = secondaryStarted;
    secondaryStarted = true;
    return (
      <div
        className={
          withDivider ? "mt-3.5 border-t border-slate-100 pt-3.5" : undefined
        }
      >
        {node}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-[var(--lab-bg,#f8fafc)]/95 backdrop-blur">
        <div className="flex items-center gap-1.5 px-3 py-2 sm:px-4">
          <BackLink
            fallback={backHref}
            compact
            hideLabel
            preferFallback
            className="-ml-1"
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {detail.foundation ? (
              <span className="inline-flex shrink-0 items-center rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold leading-none text-slate-600">
                {detail.foundation}
              </span>
            ) : null}
            <h1 className="truncate text-[15px] font-semibold leading-5 tracking-tight text-slate-900 sm:text-base">
              {detail.name}
            </h1>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-3 pb-8 pt-3 sm:gap-5 sm:px-4 sm:pt-4">
        {headerAddress ? (
          <p className="text-[12px] leading-4 text-slate-500 sm:text-[13px]">
            {headerAddress}
          </p>
        ) : null}

        {authHold ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5">
            <p className="text-sm text-slate-700">
              학교알리미 API 키가 설정되지 않아 공시 상세를 불러올 수 없습니다.
            </p>
          </section>
        ) : null}

        {!authHold &&
        detail.sectionStatus.basic === "error" &&
        !detail.schoolInfoCode ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5">
            <p className="text-sm text-slate-700">
              학교 기본정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </section>
        ) : null}

        {coreItems.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
            <SectionTitle>학교 현황</SectionTitle>
            <StatusMetrics items={coreItems} />
          </section>
        ) : null}

        {hasSecondary ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
            {lifeRows.length > 0
              ? secondaryBlock(
                  <>
                    <SectionTitle>학교생활</SectionTitle>
                    <CompactRows rows={lifeRows} />
                  </>,
                )
              : null}

            {hasAdvancement && detail.advancement
              ? secondaryBlock(
                  <>
                    <SectionTitle>진학정보</SectionTitle>
                    {detail.advancement.graduates?.value ? (
                      <p className="mt-2 text-[13px] font-semibold tabular-nums text-slate-900">
                        졸업생 {detail.advancement.graduates.value}
                      </p>
                    ) : null}
                    {detail.advancement.buckets.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {detail.advancement.buckets.map((b) => (
                          <li
                            key={b.label}
                            className="flex items-baseline justify-between gap-3 text-[13px]"
                          >
                            <span className="text-slate-600">{b.label}</span>
                            <span className="font-semibold tabular-nums text-slate-900">
                              {b.count != null
                                ? `${b.count.toLocaleString("ko-KR")}명`
                                : ""}
                              {b.count != null && b.percent != null
                                ? " · "
                                : ""}
                              {b.percent != null ? `${b.percent}%` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>,
                )
              : null}

            {scholarshipRows.length > 0
              ? secondaryBlock(
                  <>
                    <SectionTitle>장학정보</SectionTitle>
                    <CompactRows rows={scholarshipRows} />
                  </>,
                )
              : null}

            {basicRows.length > 0
              ? secondaryBlock(
                  <>
                    <SectionTitle>기본정보</SectionTitle>
                    <BasicRows rows={basicRows} />
                  </>,
                )
              : null}
          </section>
        ) : null}

        <p className="flex items-center justify-center gap-1 text-center text-[11px] text-slate-500">
          <span>{detail.attribution}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-0.5">
            출처
            <InfoTip aria-label="학교 상세 출처 안내">
              <p>데이터 출처: 학교알리미(학교정보공시)</p>
              <p className="mt-1">주변 학교 위치: NEIS</p>
              <p className="mt-1">
                공시 연도는 응답에 있을 때만 표시하며, 임의 연도는 표기하지
                않습니다.
              </p>
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
    </div>
  );
}
