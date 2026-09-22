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

const MGMT_FEE_DISCLOSURE_ACTION =
  "detail-label min-w-0 font-medium text-[color:var(--lab-navy-950)]";

function ManwonFigure({
  text,
  role = "data",
}: {
  text: string;
  role?: "summary" | "data";
}) {
  const unit = "만원";
  const numberClass =
    role === "summary"
      ? "detail-summary-value"
      : "detail-data-value-emphasis";

  if (text === "—" || !text.endsWith(unit)) {
    return <span className={numberClass}>{text}</span>;
  }

  return (
    <span className="inline-flex items-baseline gap-0.5">
      <span className={numberClass}>{text.slice(0, -unit.length)}</span>
      <span className="detail-number-unit">{unit}</span>
    </span>
  );
}

function MetricRow({
  label,
  valueLabel,
}: {
  label: string;
  valueLabel: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className="detail-label min-w-0">{label}</p>
      <ManwonFigure text={valueLabel} role="data" />
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

function trailingAverageLabel(monthCount: number | null | undefined): string {
  if (monthCount != null && Number.isFinite(monthCount) && monthCount > 0) {
    if (monthCount >= 12) return "최근 12개월 평균";
    return `최근 ${monthCount}개월 평균`;
  }
  return "최근 평균";
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="detail-label shrink-0">{label}</dt>
      <dd className="detail-meta min-w-0 text-right">{value}</dd>
    </div>
  );
}

/**
 * Management-fee summary for Complex Detail.
 * Main view stays numeric; calculation basis lives in disclosure.
 */
export function ComplexMgmtFeeCard({
  management,
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
    <LabCard className="detail-card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="detail-section-title shrink-0">관리비</h2>
        {showSelectedEstimate && estimate ? (
          <p className="detail-meta min-w-0 text-right">
            기준월 {formatMonthKo(estimate.latestMonth)}
            {" · "}
            전용 {estimate.exclusiveAreaMin.toFixed(2)}~
            {estimate.exclusiveAreaMax.toFixed(2)}㎡
          </p>
        ) : null}
      </div>

      {showSelectedEstimate && estimate ? (
        <>
          <div className="detail-after-title">
            <p className="detail-meta">최근 예상 관리비</p>
            <p className="mt-1">
              <ManwonFigure
                text={formatWonRangeAsManwon(
                  estimate.latest.wonMin,
                  estimate.latest.wonMax,
                )}
                role="summary"
              />
            </p>
          </div>

          <div className="detail-subsection-rule detail-rows">
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
              label={trailingAverageLabel(
                estimate.trailingAverage?.monthCount ?? null,
              )}
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
            <div className="detail-subsection-rule">
              <p className="detail-subsection-title">관리비 구성</p>
              <div className="detail-rows mt-3">
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

          <LabDisclosure
            title="관리비 산정근거 보기"
            className="detail-subsection"
            titleClassName={MGMT_FEE_DISCLOSURE_ACTION}
            chevronClassName="h-4 w-4"
          >
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
            </dl>

            {estimate.components.common &&
            estimate.components.individual &&
            estimate.components.reserve ? (
              <div className="detail-subsection-rule">
                <p className="detail-subsection-title">최근월 면적단가</p>
                <dl className="detail-rows mt-3">
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

            <div className="detail-subsection-rule">
              <p className="detail-subsection-title">안내</p>
              <p className="detail-body mt-1">
                주거전용면적 기준 관리비 단가를 선택 평형에 적용한 예상값입니다.
                실제 세대별 관리비는 사용량과 일부 부과항목에 따라 달라질 수
                있습니다.
              </p>
            </div>
          </LabDisclosure>
        </>
      ) : (
        <>
          <div className="detail-after-title">
            <p className="detail-meta">선택 평형 예상 관리비</p>
            <p className="detail-summary-value mt-1">
              평형별 관리비 데이터 준비 중
            </p>
          </div>

          <LabDisclosure
            title="관리비 산정근거 보기"
            className="detail-subsection"
            titleClassName={MGMT_FEE_DISCLOSURE_ACTION}
            chevronClassName="h-4 w-4"
          >
            <dl>
              <InfoRow
                label="계산 방식"
                value="주거전용면적 기준 관리비 단가 × 선택 평형 전용면적"
              />
              <InfoRow
                label="최근 자료"
                value={formatYyyymmBasisLabel(management.latest.periodYyyymm)}
              />
            </dl>
            <div className="detail-subsection-rule">
              <p className="detail-subsection-title">안내</p>
              <p className="detail-body mt-1">
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
