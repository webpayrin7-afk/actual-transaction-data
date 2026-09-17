import type { ReactNode } from "react";
import { BackLink } from "@/components/layout/BackLink";
import { AdvancementSection } from "@/components/school/AdvancementSection";
import { DataAttribution } from "@/components/ui/DataAttribution";
import type {
  ProductMetric,
  ProductSchoolDetail,
} from "@/lib/school-info/product-school-detail";

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
function StatusMetrics({ items }: { items: ProductMetric[] }) {
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

  const basicRows: Array<{ label: string; value: ReactNode; long?: boolean }> =
    [];
  if (detail.foundation) {
    basicRows.push({ label: "설립구분", value: detail.foundation });
  }
  if (detail.coedu) {
    basicRows.push({ label: "남녀공학", value: detail.coedu });
  }
  if (detail.kind) {
    basicRows.push({ label: "학교급", value: detail.kind });
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <header className="sticky top-0 z-30 bg-[var(--lab-bg,#f8fafc)]/95 backdrop-blur">
        <div className="flex items-center gap-1.5 px-3 py-2 sm:px-4">
          <BackLink
            fallback={backHref}
            compact
            hideLabel
            preferFallback
            className="-ml-1"
          />
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold leading-7 tracking-tight text-slate-900 sm:text-[1.375rem] sm:leading-8">
            {detail.name}
          </h1>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-3 pb-8 pt-3 sm:gap-5 sm:px-4 sm:pt-4">
        {detail.authHold ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5">
            <p className="text-sm text-slate-700">
              공시 상세를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </section>
        ) : null}

        {!detail.authHold && detail.unresolved ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5">
            <p className="text-sm text-slate-700">
              이 학교의 공시 정보를 찾지 못했습니다.
            </p>
          </section>
        ) : null}

        {!detail.authHold && detail.basicError ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5">
            <p className="text-sm text-slate-700">
              학교 기본정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          </section>
        ) : null}

        {/* 1. 기본정보 */}
        {basicRows.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
            <SectionTitle>기본정보</SectionTitle>
            <BasicRows rows={basicRows} />
          </section>
        ) : null}

        {/* 2. 학교 현황 */}
        {coreItems.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
            <SectionTitle>학교 현황</SectionTitle>
            <StatusMetrics items={coreItems} />
          </section>
        ) : null}

        {/* 3. 진학/진학·진로 현황 — DATA CONTEXT (year) stays on section */}
        <AdvancementSection data={detail.advancement} schoolKind={detail.kind} />

        {/* 4. 학교생활 (급식 · 방과후 · 장학) */}
        {lifeRows.length > 0 ? (
          <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
            <SectionTitle>학교생활</SectionTitle>
            <CompactRows rows={lifeRows} />
          </section>
        ) : null}

        {detail.schoolInfoUrl ? (
          <a
            href={detail.schoolInfoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="lab-button lab-button-primary inline-flex w-full items-center justify-center rounded-xl px-3.5 py-3 text-[13px] font-semibold"
          >
            학교알리미에서 보기
          </a>
        ) : null}

        {/* REQUIRED ATTRIBUTION — once, after all page content */}
        {detail.attribution ? (
          <footer className="mt-2 border-t border-slate-200/80 pt-4 sm:mt-3 sm:pt-5">
            <DataAttribution label={detail.attribution} />
          </footer>
        ) : null}
      </div>
    </div>
  );
}
