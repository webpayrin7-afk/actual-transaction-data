"use client";

import type { ReactNode } from "react";
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
import {
  COMMERCE_COMPOSITION_ORDER,
  COMMERCE_FACILITY_ORDER,
  commerceTopCategoryDisplayName,
  formatCommerceCount,
  formatCommerceShare,
  type CommerceFacilities,
  type CommerceSnapshot,
} from "@/lib/complex-detail/commerce-snapshot";

function FacilityIcon({
  keyName,
  className = "h-3.5 w-3.5",
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

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[14px] font-semibold tracking-tight text-slate-800">
      {children}
    </h3>
  );
}

function thinDividerClass() {
  return "border-t border-slate-100";
}

/**
 * Compact SEMAS census blocks for the commerce tab.
 * Driven only by CommerceSnapshot — no NAVER counts mixed in.
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

  return (
    <div className="space-y-4">
      {/* 생활 상권 규모 */}
      <section>
        <div className="flex items-baseline justify-between gap-2">
          <SectionHeading>생활 상권</SectionHeading>
          <span className="text-[11px] text-slate-500">
            반경 {radiusKm} · {snapshot.sourcePeriodLabel}
          </span>
        </div>
        <div className="mt-1.5 flex items-end gap-1.5">
          <p className="text-[28px] font-bold leading-none tracking-tight text-[#1e3a5f] tabular-nums">
            {formatCommerceCount(snapshot.p2Total)}
            <span className="ml-0.5 text-[15px] font-semibold text-slate-700">
              개
            </span>
          </p>
          <InfoTip
            aria-label="생활 상권 집계 안내"
            className="mb-0.5 text-[12px]"
          >
            <p className="text-[12px] leading-relaxed text-slate-600">
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
        <p className="mt-1 text-[12px] text-slate-500">
          반경 {radiusKm} 내 생활 밀착 업소
        </p>
        {leadingComposition && leadingComposition.key === "음식/외식" ? (
          <p className="mt-1.5 text-[12px] text-slate-600">
            음식/외식 업종 비중이 가장 높아요.
          </p>
        ) : null}
      </section>

      <div className={thinDividerClass()} />

      {/* 업종 구성 */}
      <section>
        <SectionHeading>업종 구성</SectionHeading>
        {/* Compact stacked bar */}
        <div
          className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label="업종 구성 비율"
        >
          {COMMERCE_COMPOSITION_ORDER.map((key, i) => {
            const bucket = snapshot.composition[key];
            if (!bucket || bucket.share <= 0) return null;
            const tones = [
              "bg-[var(--lab-teal-600)]",
              "bg-[color-mix(in_srgb,var(--lab-teal-600)_72%,#1e3a5f)]",
              "bg-[color-mix(in_srgb,var(--lab-teal-600)_48%,#64748b)]",
              "bg-slate-400",
              "bg-slate-300",
              "bg-slate-200",
            ];
            return (
              <span
                key={key}
                className={`h-full ${tones[i] ?? "bg-slate-300"}`}
                style={{ width: `${bucket.share}%` }}
                title={`${key} ${formatCommerceShare(bucket.share)}`}
              />
            );
          })}
        </div>
        <ul className="mt-2.5 space-y-1.5">
          {COMMERCE_COMPOSITION_ORDER.map((key) => {
            const bucket = snapshot.composition[key];
            if (!bucket || bucket.count <= 0) return null;
            return (
              <li key={key} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate text-slate-700">{key}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-slate-800">
                    {formatCommerceShare(bucket.share)}
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-[color-mix(in_srgb,var(--lab-teal-600)_55%,transparent)]"
                    style={{ width: `${Math.min(100, bucket.share)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <div className={thinDividerClass()} />

      {/* 주요 생활시설 */}
      <section>
        <SectionHeading>주요 생활시설</SectionHeading>
        <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-2.5">
          {COMMERCE_FACILITY_ORDER.map(({ key, label }) => (
            <div
              key={key}
              className="flex min-w-0 flex-col items-center px-1 py-1.5 text-center"
            >
              <span className="inline-flex h-6 w-6 items-center justify-center text-[#1e3a5f]">
                <FacilityIcon keyName={key} />
              </span>
              <span className="mt-0.5 truncate text-[10px] leading-tight text-slate-500">
                {label}
              </span>
              <span className="mt-0.5 text-[15px] font-bold leading-none tabular-nums text-slate-800">
                {formatCommerceCount(snapshot.facilities[key])}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className={thinDividerClass()} />

      {/* 주요 업종 TOP5 */}
      <section>
        <SectionHeading>주요 업종</SectionHeading>
        <ol className="mt-2 space-y-2">
          {snapshot.topCategories.slice(0, 5).map((cat, idx) => {
            const label = commerceTopCategoryDisplayName(cat);
            const pct = (cat.count / topMax) * 100;
            return (
              <li key={cat.code} className="min-w-0">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="w-3.5 shrink-0 text-[11px] font-semibold text-slate-400 tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {label}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-slate-800">
                    {formatCommerceCount(cat.count)}
                  </span>
                </div>
                <div className="ml-5 mt-0.5 h-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-[color-mix(in_srgb,#1e3a5f_35%,transparent)]"
                    style={{ width: `${pct}%` }}
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
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-slate-600">
      <span className="font-semibold text-slate-800">생활 상권</span>
      <span className="text-slate-300" aria-hidden>
        ·
      </span>
      <span>
        반경 {radiusKm} · {snapshot.sourcePeriodLabel}
      </span>
      <InfoTip aria-label="생활 상권 안내" className="text-[11px]">
        <p className="text-[12px] leading-relaxed text-slate-600">
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
    <div className="rounded-lg bg-slate-50/80 px-3 py-3">
      <p className="text-sm text-slate-600">상권 데이터를 준비 중입니다.</p>
    </div>
  );
}
