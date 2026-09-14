"use client";

import { useMemo } from "react";
import { LabCard } from "@/components/ui/lab";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import {
  formatYyyymmBasisLabel,
  formatYyyymmLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
  reconcileLatestComponents,
} from "@/lib/complex-detail/selected-pyeong-mgmt-fee";
import { MANAGEMENT_AREA_FEE_NOTE } from "@/lib/complex-detail/source-status";

function MetricRow({
  label,
  valueLabel,
  hint,
}: {
  label: string;
  valueLabel: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm text-slate-600">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>
        ) : null}
      </div>
      <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-800">
        {valueLabel}
      </p>
    </div>
  );
}

function formatMonthKo(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}년 ${Number(yyyymm.slice(4, 6))}월`;
}

/**
 * Management-fee summary for Complex Detail.
 *
 * Pilot (잠실엘스): selected-pyeong estimate from portal OpenAPI derived 원/㎡.
 * Non-pilot: pending copy only — never fall back to complex÷households.
 */
export function ComplexMgmtFeeCard({
  management,
  selectedPyeongLabel,
  exclusiveAreaMinSqm,
  exclusiveAreaMaxSqm,
}: {
  management: ComplexManagementV1;
  /** e.g. "33평" when an area group is selected; omit/"전체" when none. */
  selectedPyeongLabel?: string | null;
  exclusiveAreaMinSqm?: number | null;
  exclusiveAreaMaxSqm?: number | null;
  aptName?: string | null;
  complexId?: string | null;
}) {
  const pyeongTitle =
    selectedPyeongLabel && selectedPyeongLabel !== "전체"
      ? selectedPyeongLabel
      : null;

  const areaMin = exclusiveAreaMinSqm ?? null;
  const areaMax = exclusiveAreaMaxSqm ?? exclusiveAreaMinSqm ?? null;
  const hasPortalData = management.portalAreaFees.length > 0;

  const estimate = useMemo(() => {
    if (!hasPortalData || areaMin == null || areaMax == null) return null;
    return estimateSelectedPyeongFromPortal({
      monthsDesc: management.portalAreaFees,
      exclusiveAreaMin: areaMin,
      exclusiveAreaMax: areaMax,
      kaptCode: "A13822004",
    });
  }, [hasPortalData, management.portalAreaFees, areaMin, areaMax]);

  const reconcile = useMemo(
    () => (estimate ? reconcileLatestComponents(estimate) : null),
    [estimate],
  );

  const showSelectedEstimate = estimate != null && pyeongTitle != null;

  return (
    <LabCard className="p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
          관리비
        </h2>
        <p className="shrink-0 text-xs font-medium text-slate-500 sm:text-sm">
          {showSelectedEstimate
            ? `${pyeongTitle} 기준`
            : pyeongTitle
              ? `${pyeongTitle} · 데이터 준비 중`
              : "선택 평형 · 데이터 준비 중"}
        </p>
      </div>

      {showSelectedEstimate && estimate ? (
        <>
          <div className="mt-3">
            <p className="text-sm text-slate-600">최근 예상 관리비</p>
            <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900">
              약{" "}
              {formatWonRangeAsManwon(
                estimate.latest.wonMin,
                estimate.latest.wonMax,
              )}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              {formatMonthKo(estimate.latestMonth)} ·{" "}
              {estimate.areaBasisLabelKo} 기준
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              전용 {estimate.exclusiveAreaMin.toFixed(2)}~
              {estimate.exclusiveAreaMax.toFixed(2)}㎡
            </p>
          </div>

          <div className="mt-4 border-t border-slate-200/80 pt-1">
            <MetricRow
              label="겨울 평균"
              valueLabel={
                estimate.winter
                  ? `약 ${formatWonRangeAsManwon(
                      estimate.winter.wonMin,
                      estimate.winter.wonMax,
                    )}`
                  : "—"
              }
              hint={estimate.winter?.hint}
            />
            <MetricRow
              label="여름 평균"
              valueLabel={
                estimate.summer
                  ? `약 ${formatWonRangeAsManwon(
                      estimate.summer.wonMin,
                      estimate.summer.wonMax,
                    )}`
                  : "—"
              }
              hint={estimate.summer?.hint}
            />
            <MetricRow
              label="최근 12개월 평균"
              valueLabel={
                estimate.trailingAverage
                  ? `약 ${formatWonRangeAsManwon(
                      estimate.trailingAverage.wonMin,
                      estimate.trailingAverage.wonMax,
                    )}`
                  : "—"
              }
              hint={estimate.trailingAverage?.hint}
            />
          </div>

          {estimate.components.common &&
          estimate.components.individual &&
          estimate.components.reserve ? (
            <div className="mt-2 border-t border-slate-200/80 pt-1">
              <p className="pt-2 text-sm font-medium text-slate-800">
                관리비 구성
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {formatMonthKo(estimate.latestMonth)} · 선택 평형 면적단가 환산
              </p>
              <div className="mt-1">
                <MetricRow
                  label="공용관리비"
                  valueLabel={formatWonRangeAsManwon(
                    estimate.components.common.wonMin,
                    estimate.components.common.wonMax,
                  )}
                />
                <MetricRow
                  label="개별사용료"
                  valueLabel={formatWonRangeAsManwon(
                    estimate.components.individual.wonMin,
                    estimate.components.individual.wonMax,
                  )}
                />
                <MetricRow
                  label="장기수선충당금"
                  valueLabel={formatWonRangeAsManwon(
                    estimate.components.reserve.wonMin,
                    estimate.components.reserve.wonMax,
                  )}
                />
              </div>
            </div>
          ) : null}

          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            {estimate.disclaimer}
          </p>

          <LabDisclosure title="계산 기준 및 세부내역" className="mt-3">
            <ul className="space-y-2 text-sm leading-relaxed text-slate-700">
              <li>
                출처: {estimate.sourceLabelKo}
                {estimate.kaptCode ? ` (${estimate.kaptCode})` : null} ·{" "}
                {estimate.areaBasisLabelKo} 원/㎡ × 선택 전용면적
              </li>
              <li>
                최근월 단가{" "}
                {estimate.latest.perM2.toLocaleString("ko-KR", {
                  maximumFractionDigits: 2,
                })}
                원/㎡
                {estimate.components.common
                  ? ` (공용 ${estimate.components.common.perM2.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} · 개별 ${estimate.components.individual!.perM2.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} · 충당금 ${estimate.components.reserve!.perM2.toLocaleString("ko-KR", { maximumFractionDigits: 2 })})`
                  : null}
              </li>
              <li>
                겨울은 연속 12·1·2월, 여름은 동일 연도 6·7·8월만 사용합니다.
                {estimate.winter?.monthsUsed.length
                  ? ` 겨울 표본: ${estimate.winter.monthsUsed.map(formatYyyymmLabel).join(", ")}.`
                  : ""}
                {estimate.summer?.monthsUsed.length
                  ? ` 여름 표본: ${estimate.summer.monthsUsed.map(formatYyyymmLabel).join(", ")}.`
                  : ""}
              </li>
              <li>
                최근 평균은 연속 COMPLETE 월(최대 12)의 원/㎡ 평균을 선택 면적에
                적용한 값입니다.
                {estimate.trailingAverage
                  ? ` (${estimate.trailingAverage.monthCount}개월)`
                  : ""}
              </li>
              <li>{estimate.knownMissingNote}</li>
              {reconcile ? (
                <li>
                  구성 합계 검증:{" "}
                  {reconcile.ok
                    ? "공용+개별+충당금 = 최근 총액 (원 단위 일치)"
                    : "구성 합계와 총액이 불일치 — 표시 보류 검토 필요"}
                </li>
              ) : null}
              <li>
                단지 총액÷세대수 평균은 선택 평형 예상값으로 사용하지 않습니다.
              </li>
            </ul>
          </LabDisclosure>
        </>
      ) : (
        <>
          <div className="mt-3">
            <p className="text-sm text-slate-600">선택 평형 예상 관리비</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              평형별 관리비 데이터 준비 중
            </p>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              {hasPortalData && !pyeongTitle
                ? "평형을 선택하면 주거전용면적 기준 예상 관리비를 표시합니다."
                : hasPortalData && (areaMin == null || areaMax == null)
                  ? "선택 평형의 전용면적 정보가 없어 예상 관리비를 계산할 수 없습니다."
                  : "이 단지의 공공데이터 OpenAPI 기반 면적단가(원/㎡)가 아직 없어 선택 평형 금액을 표시하지 않습니다."}
            </p>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            단지 전체÷세대수 평균은 선택 평형 관리비로 사용하지 않습니다.
          </p>

          <LabDisclosure title="계산 기준 및 세부내역" className="mt-3">
            <ul className="space-y-2 text-sm leading-relaxed text-slate-700">
              <li>{management.disclaimer}</li>
              <li>
                최신 단지 월 자료:{" "}
                {formatYyyymmBasisLabel(management.latest.periodYyyymm)} (참고용
                메타 — 선택 평형 금액 아님)
              </li>
              <li>{MANAGEMENT_AREA_FEE_NOTE}</li>
            </ul>
          </LabDisclosure>
        </>
      )}
    </LabCard>
  );
}
