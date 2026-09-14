"use client";

import { useMemo } from "react";
import { LabCard } from "@/components/ui/lab";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import {
  formatYyyymmBasisLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
} from "@/lib/complex-detail/selected-pyeong-mgmt-fee";

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

function formatWonPerSqm(n: number): string {
  return `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원/㎡`;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-sm text-slate-600">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium leading-snug text-slate-800">
        {value}
      </dd>
    </div>
  );
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
    });
  }, [hasPortalData, management.portalAreaFees, areaMin, areaMax]);

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

          <LabDisclosure title="계산 기준 및 세부내역" className="mt-3">
            <dl>
              <InfoRow
                label="계산 방식"
                value="주거전용면적 기준 관리비 단가 × 선택 평형 전용면적"
              />
              <InfoRow
                label="기준월"
                value={formatMonthKo(estimate.latestMonth)}
              />
              <InfoRow
                label="선택 면적"
                value={`전용 ${estimate.exclusiveAreaMin.toFixed(2)}~${estimate.exclusiveAreaMax.toFixed(2)}㎡`}
              />
              <InfoRow
                label="평균 기준"
                value="겨울 12~2월 · 여름 6~8월 · 최근 평균 최대 12개월"
              />
              <InfoRow label="출처" value={estimate.sourceLabelKo} />
            </dl>

            {estimate.components.common &&
            estimate.components.individual &&
            estimate.components.reserve ? (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <p className="pb-0.5 text-sm font-medium text-slate-800">
                  최근월 면적단가
                </p>
                <dl>
                  <InfoRow
                    label="공용관리비"
                    value={formatWonPerSqm(estimate.components.common.perM2)}
                  />
                  <InfoRow
                    label="개별사용료"
                    value={formatWonPerSqm(estimate.components.individual.perM2)}
                  />
                  <InfoRow
                    label="장기수선충당금"
                    value={formatWonPerSqm(estimate.components.reserve.perM2)}
                  />
                  <InfoRow
                    label="합계"
                    value={formatWonPerSqm(estimate.latest.perM2)}
                  />
                </dl>
              </div>
            ) : null}

            <div className="mt-2 border-t border-slate-100 pt-2">
              <p className="text-sm font-medium text-slate-800">안내</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">
                주거전용면적 기준 관리비 단가를 선택 평형에 적용한 예상값입니다.
                실제 세대별 관리비는 사용량과 일부 부과항목에 따라 달라질 수
                있습니다.
              </p>
            </div>
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
                  : "이 단지의 면적단가가 아직 없어 선택 평형 금액을 표시하지 않습니다."}
            </p>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            평형별 예상 관리비는 주거전용면적 단가가 있는 단지에서만 표시합니다.
          </p>

          <LabDisclosure title="계산 기준 및 세부내역" className="mt-3">
            <dl>
              <InfoRow
                label="계산 방식"
                value="주거전용면적 기준 관리비 단가 × 선택 평형 전용면적"
              />
              <InfoRow
                label="출처"
                value="국토교통부 공동주택관리정보 공공데이터"
              />
              <InfoRow
                label="최근 자료"
                value={formatYyyymmBasisLabel(management.latest.periodYyyymm)}
              />
            </dl>
            <div className="mt-2 border-t border-slate-100 pt-2">
              <p className="text-sm font-medium text-slate-800">안내</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">
                이 단지는 아직 선택 평형 예상 관리비를 표시할 수 없습니다.
                단지 전체 평균은 선택 평형 금액으로 쓰지 않습니다.
              </p>
            </div>
          </LabDisclosure>
        </>
      )}
    </LabCard>
  );
}
