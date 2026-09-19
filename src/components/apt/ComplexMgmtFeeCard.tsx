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
}: {
  label: string;
  valueLabel: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <p className="apt-type-body min-w-0 text-slate-600">{label}</p>
      <p className="apt-type-sub-metric shrink-0 text-slate-800">
        {valueLabel}
      </p>
    </div>
  );
}

function formatMonthKo(yyyymm: string): string {
  if (yyyymm.length !== 6) return yyyymm;
  return `${yyyymm.slice(0, 4)}년 ${Number(yyyymm.slice(4, 6))}월`;
}

function formatSeasonPeriod(months: string[], season: "winter" | "summer"): string {
  if (months.length === 0) return "—";
  const year = months[0]!.slice(0, 4);
  const seasonKo = season === "winter" ? "겨울" : "여름";
  if (months.length >= 3) return `${year}년 ${seasonKo}`;
  return `${year}년 ${seasonKo} · ${months.length}개월 평균`;
}

function formatWonPerSqm(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}원/㎡`;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="apt-type-secondary shrink-0">{label}</dt>
      <dd className="apt-type-body min-w-0 text-right text-slate-800">
        {value}
      </dd>
    </div>
  );
}

/**
 * Management-fee summary for Complex Detail.
 * Main view stays numeric; calculation basis lives in disclosure.
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

  const showSelectedEstimate = estimate != null;

  return (
    <LabCard className="p-4 sm:p-5">
      <h2 className="apt-type-section-title">
        관리비
      </h2>

      {showSelectedEstimate && estimate ? (
        <>
          <div className="mt-3">
            <p className="apt-type-body text-slate-600">최근 예상 관리비</p>
            <p className="apt-type-main-metric mt-1">
              {formatWonRangeAsManwon(
                estimate.latest.wonMin,
                estimate.latest.wonMax,
              )}
            </p>
          </div>

          <div className="mt-4 border-t border-slate-200/80 pt-1">
            <MetricRow
              label="겨울 평균"
              valueLabel={
                estimate.winter
                  ? formatWonRangeAsManwon(
                      estimate.winter.wonMin,
                      estimate.winter.wonMax,
                    )
                  : "—"
              }
            />
            <MetricRow
              label="여름 평균"
              valueLabel={
                estimate.summer
                  ? formatWonRangeAsManwon(
                      estimate.summer.wonMin,
                      estimate.summer.wonMax,
                    )
                  : "—"
              }
            />
            <MetricRow
              label="최근 12개월 평균"
              valueLabel={
                estimate.trailingAverage
                  ? formatWonRangeAsManwon(
                      estimate.trailingAverage.wonMin,
                      estimate.trailingAverage.wonMax,
                    )
                  : "—"
              }
            />
          </div>

          {estimate.components.common &&
          estimate.components.individual &&
          estimate.components.reserve ? (
            <div className="mt-2 border-t border-slate-200/80 pt-1">
              <p className="apt-type-body-semibold pt-2">
                관리비 구성
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

          <LabDisclosure title="관리비 산정근거 보기" titleClassName="apt-type-body-semibold" className="mt-3">
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
              <InfoRow
                label="겨울"
                value={
                  estimate.winter
                    ? formatSeasonPeriod(estimate.winter.monthsUsed, "winter")
                    : "—"
                }
              />
              <InfoRow
                label="여름"
                value={
                  estimate.summer
                    ? formatSeasonPeriod(estimate.summer.monthsUsed, "summer")
                    : "—"
                }
              />
              <InfoRow
                label="최근 평균"
                value={
                  estimate.trailingAverage
                    ? `최대 ${estimate.trailingAverage.monthCount}개월`
                    : "—"
                }
              />
              <InfoRow label="출처" value={estimate.sourceLabelKo} />
            </dl>

            {estimate.components.common &&
            estimate.components.individual &&
            estimate.components.reserve ? (
              <div className="mt-2 border-t border-slate-100 pt-2">
                <p className="apt-type-body-semibold pb-0.5">
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
              <p className="apt-type-body-semibold">안내</p>
              <p className="apt-type-secondary mt-1">
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
            <p className="apt-type-body text-slate-600">선택 평형 예상 관리비</p>
            <p className="apt-type-secondary mt-1">
              평형별 관리비 데이터 준비 중
            </p>
          </div>

          <LabDisclosure title="관리비 산정근거 보기" titleClassName="apt-type-body-semibold" className="mt-3">
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
              <p className="apt-type-body-semibold">안내</p>
              <p className="apt-type-secondary mt-1">
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
