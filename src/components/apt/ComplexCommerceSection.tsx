"use client";

import {
  Coffee,
  Dumbbell,
  GraduationCap,
  Hospital,
  Pill,
  Scissors,
  ShoppingCart,
  Store,
  UtensilsCrossed,
} from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabSubsectionHeader } from "@/components/ui/LabSection";
import {
  COMMERCE_COMPOSITION_ORDER,
  COMMERCE_FACILITY_ORDER,
  commerceTopCategoryDisplayName,
  formatCommerceCount,
  formatCommerceShare,
  type CommerceFacilities,
  type CommerceSnapshot,
} from "@/lib/complex-detail/commerce-snapshot";
import {
  commerceCategoryColor,
  commercePresentationBucketFromMcls,
  COMMERCE_CATEGORY_CSS_VAR,
  COMMERCE_FACILITY_CATEGORY,
  type CommerceCategoryColorKey,
} from "@/lib/complex-detail/commerce-category-colors";

export function FacilityIcon({
  keyName,
  className = "h-5 w-5",
}: {
  keyName: keyof CommerceFacilities;
  className?: string;
}) {
  switch (keyName) {
    case "병원/의원":
      return <Hospital className={className} aria-hidden strokeWidth={1.75} />;
    case "약국":
      return <Pill className={className} aria-hidden strokeWidth={1.75} />;
    case "편의점":
      return <Store className={className} aria-hidden strokeWidth={1.75} />;
    case "마트/슈퍼":
      return (
        <ShoppingCart className={className} aria-hidden strokeWidth={1.75} />
      );
    case "카페":
      return <Coffee className={className} aria-hidden strokeWidth={1.75} />;
    case "음식점":
      return (
        <UtensilsCrossed className={className} aria-hidden strokeWidth={1.75} />
      );
    case "미용":
      return <Scissors className={className} aria-hidden strokeWidth={1.75} />;
    case "학원":
      return (
        <GraduationCap className={className} aria-hidden strokeWidth={1.75} />
      );
    case "체육":
      return <Dumbbell className={className} aria-hidden strokeWidth={1.75} />;
    default:
      return <Store className={className} aria-hidden strokeWidth={1.75} />;
  }
}

function catCssVar(key: CommerceCategoryColorKey | null | undefined): string {
  if (key && key in COMMERCE_CATEGORY_CSS_VAR) {
    return COMMERCE_CATEGORY_CSS_VAR[key];
  }
  return "var(--lab-muted)";
}

function SectionHeading({ children }: { children: string }) {
  return <LabSubsectionHeader title={children} />;
}

function thinDividerClass() {
  return "detail-subsection-rule !mt-6 !pt-6";
}

/**
 * Compact SEMAS census blocks for the commerce tab.
 * Driven only by CommerceSnapshot — no NAVER counts mixed in.
 * Individual bar + ratio only (no redundant stacked bar).
 */
export function ComplexCommerceStats({
  snapshot,
}: {
  snapshot: CommerceSnapshot;
}) {
  const radiusKm = snapshot.radiusM >= 1000
    ? `${snapshot.radiusM / 1000}km`
    : `${snapshot.radiusM}m`;
  const topMax = Math.max(
    ...snapshot.topCategories.map((c) => c.count),
    1,
  );
  const leadingComposition = COMMERCE_COMPOSITION_ORDER.reduce<{
    key: (typeof COMMERCE_COMPOSITION_ORDER)[number];
    share: number;
  } | null>((best, key) => {
    const share = snapshot.composition[key]?.share ?? 0;
    if (!best || share > best.share) return { key, share };
    return best;
  }, null);

  const compositionMax = Math.max(
    ...COMMERCE_COMPOSITION_ORDER.map(
      (key) => snapshot.composition[key]?.share ?? 0,
    ),
    1,
  );

  return (
    <div className="space-y-0">
      {/* 생활 상권 규모 */}
      <section>
        <div className="flex items-baseline justify-between gap-2">
          <SectionHeading>생활 상권</SectionHeading>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <p className="detail-summary-value leading-none">
            {formatCommerceCount(snapshot.p2Total)}
            <span className="detail-label ml-0.5">개</span>
          </p>
          <InfoTip aria-label="생활 상권 집계 안내">
            <p className="detail-body">
              단지 중심 반경 {radiusKm} 내 상가업소 중 일상생활과 밀접한 업종을
              집계합니다. 거리는 직선거리 기준입니다.
              <br />
              <br />
              {snapshot.sourcePeriodLabel} 소상공인시장진흥공단 상가업소 데이터
              기준.
              <br />
              전체 상가업소 {formatCommerceCount(snapshot.p0Total)}개 중 생활
              밀착 업종 {formatCommerceCount(snapshot.p2Total)}개.
            </p>
          </InfoTip>
        </div>
        {leadingComposition && leadingComposition.key === "음식/외식" ? (
          <p className="detail-body mt-1.5">음식/외식 업종 비중이 가장 높아요.</p>
        ) : null}
      </section>

      <div className={thinDividerClass()} />

      {/* 업종 구성 — bar + ratio only */}
      <section>
        <SectionHeading>업종 구성</SectionHeading>
        <ul className="mt-3 space-y-2.5">
          {COMMERCE_COMPOSITION_ORDER.map((key) => {
            const bucket = snapshot.composition[key];
            if (!bucket || bucket.count <= 0) return null;
            const color = catCssVar(key as CommerceCategoryColorKey);
            const widthPct = Math.min(
              100,
              (bucket.share / compositionMax) * 100,
            );
            return (
              <li key={key} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="detail-label flex min-w-0 items-center gap-1.5 truncate text-[color:var(--lab-navy-950)]">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: color }}
                      aria-hidden
                    />
                    <span className="truncate">{key}</span>
                  </span>
                  <span className="detail-label shrink-0 font-medium tabular-nums text-[color:var(--lab-navy-950)]">
                    {formatCommerceShare(bucket.share)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${widthPct}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <div className={thinDividerClass()} />

      {/* 주요 생활시설 — 3-col, compact-value 18, label 13 */}
      <section>
        <SectionHeading>주요 생활시설</SectionHeading>
        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-5 [@media(min-resolution:2dppx)_and_(max-width:360px)]:grid-cols-2">
          {COMMERCE_FACILITY_ORDER.map(({ key, label }) => {
            const catKey = COMMERCE_FACILITY_CATEGORY[key];
            const color = catCssVar(catKey);
            const soft = commerceCategoryColor(catKey).soft;
            return (
              <div
                key={key}
                className="flex min-w-0 flex-col items-center px-1 text-center"
              >
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md"
                  style={{
                    color,
                    backgroundColor: soft,
                  }}
                >
                  <FacilityIcon keyName={key} />
                </span>
                <span className="detail-meta mt-1 truncate">{label}</span>
                <span className="detail-compact-value mt-0.5 leading-none">
                  {formatCommerceCount(snapshot.facilities[key])}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <div className={thinDividerClass()} />

      {/* 주요 업종 TOP5 */}
      <section>
        <SectionHeading>주요 업종</SectionHeading>
        <ol className="mt-3 space-y-2.5">
          {snapshot.topCategories.slice(0, 5).map((cat, idx) => {
            const label = commerceTopCategoryDisplayName(cat);
            const pct = (cat.count / topMax) * 100;
            const bucket = commercePresentationBucketFromMcls(cat.code);
            const color =
              bucket !== "기타"
                ? catCssVar(bucket as CommerceCategoryColorKey)
                : "var(--lab-muted)";
            return (
              <li key={cat.code} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="detail-meta w-4 shrink-0 font-semibold tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="detail-label min-w-0 flex-1 truncate text-[color:var(--lab-navy-950)]">
                    {label}
                  </span>
                  <span className="detail-label shrink-0 font-medium tabular-nums text-[color:var(--lab-navy-950)]">
                    {formatCommerceCount(cat.count)}
                  </span>
                </div>
                <div className="ml-6 mt-1 h-1.5 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** Compact top meta shown above the map on commerce tab. */
export function ComplexCommerceMeta({
  snapshot,
}: {
  snapshot: CommerceSnapshot;
}) {
  const radiusKm =
    snapshot.radiusM >= 1000
      ? `${snapshot.radiusM / 1000}km`
      : `${snapshot.radiusM}m`;

  return (
    <div className="detail-meta flex flex-wrap items-center gap-y-0.5">
      <span>
        반경 {radiusKm} · {snapshot.sourcePeriodLabel}
      </span>
      <InfoTip aria-label="생활 상권 안내" className="detail-meta">
        <p className="detail-body">
          단지 중심 반경 {radiusKm} 내 상가업소 중 일상생활과 밀접한 업종을
          집계합니다. 거리는 직선거리 기준입니다.
          <br />
          <br />
          {snapshot.sourcePeriodLabel} 소상공인시장진흥공단 상가업소 데이터
          기준.
          <br />
          전체 상가업소 {formatCommerceCount(snapshot.p0Total)}개 중 생활 밀착
          업종 {formatCommerceCount(snapshot.p2Total)}개.
        </p>
      </InfoTip>
    </div>
  );
}

export function ComplexCommercePreparing() {
  return (
    <div className="rounded-lg bg-[color:var(--lab-surface-subtle)] px-3 py-3">
      <p className="detail-body">상권 데이터를 준비 중입니다.</p>
    </div>
  );
}
