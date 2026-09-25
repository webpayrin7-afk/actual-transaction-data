"use client";

import { useMemo } from "react";
import { LAB_SUBSECTION_RULE, LabSection, LabSubsectionHeader } from "@/components/ui/LabSection";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import {
  formatYyyymmBasisLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";
import {
  estimateSelectedPyeongFromPortal,
  formatWonRangeAsManwon,
  type SelectedPyeongMgmtFeeEstimate,
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
      <span className="detail-label">{unit}</span>
    </span>
  );
}

function MetricRow({
  label,
  valueLabel,
  emphasize = false,
}: {
  label: string;
  valueLabel: string;
  /** Larger summary-value type for the primary estimate row. */
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p
        className={
          emphasize
            ? "detail-label min-w-0 font-medium text-[color:var(--lab-navy-950)]"
            : "detail-label min-w-0"
        }
      >
        {label}
      </p>
      <ManwonFigure text={valueLabel} role={emphasize ? "summary" : "data"} />
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

/**
 * 월별 추이: 막대(선택 면적 중간값) + 최고/최저 달 수치 병기 (policy §12.7 막대만으로 전달 금지).
 * 가장 최근 달만 진하게, 나머지는 옅게.
 */
function MgmtFeeMonthlyBars({
  monthly,
}: {
  monthly: SelectedPyeongMgmtFeeEstimate["monthly"];
}) {
  if (monthly.length < 3) return null;
  const mid = (m: (typeof monthly)[number]) => (m.wonMin + m.wonMax) / 2;
  const max = Math.max(...monthly.map(mid));
  const hi = monthly.reduce((a, b) => (mid(b) > mid(a) ? b : a));
  const lo = monthly.reduce((a, b) => (mid(b) < mid(a) ? b : a));
  const monthLabel = (ym: string) => `${Number(ym.slice(4, 6))}월`;
  const first = monthly[0]!.periodYyyymm;
  const last = monthly[monthly.length - 1]!.periodYyyymm;

  return (
    <div className={`${LAB_SUBSECTION_RULE} flex flex-col gap-3`}>
      <LabSubsectionHeader
        title="월별 추이"
        meta={`${formatMonthKo(first)} ~ ${formatMonthKo(last)}`}
      />
      <div
        className="grid h-28 items-end gap-1"
        style={{ gridTemplateColumns: `repeat(${monthly.length}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {monthly.map((m, i) => (
          <div key={m.periodYyyymm} className="flex h-full flex-col justify-end">
            <div
              className="w-full rounded-t-sm"
              style={{
                height: `${Math.max(4, (mid(m) / max) * 100)}%`,
                background: "var(--lab-brand-primary)",
                opacity: i === monthly.length - 1 ? 1 : 0.35,
              }}
            />
          </div>
        ))}
      </div>
      <div
        className="grid gap-1 text-center text-[12px] leading-4 tabular-nums text-[color:var(--lab-muted)]"
        style={{ gridTemplateColumns: `repeat(${monthly.length}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {monthly.map((m, i) => (
          <span key={m.periodYyyymm}>
            {i % 2 === (monthly.length - 1) % 2 ? Number(m.periodYyyymm.slice(4, 6)) : ""}
          </span>
        ))}
      </div>
      <div className="detail-rows">
        <MetricRow
          label={`가장 높은 달 · ${monthLabel(hi.periodYyyymm)}`}
          valueLabel={formatWonRangeAsManwon(hi.wonMin, hi.wonMax)}
        />
        <MetricRow
          label={`가장 낮은 달 · ${monthLabel(lo.periodYyyymm)}`}
          valueLabel={formatWonRangeAsManwon(lo.wonMin, lo.wonMax)}
        />
      </div>
      <table className="sr-only">
        <caption>월별 예상 관리비</caption>
        <tbody>
          {monthly.map((m) => (
            <tr key={m.periodYyyymm}>
              <th scope="row">{formatMonthKo(m.periodYyyymm)}</th>
              <td>{formatWonRangeAsManwon(m.wonMin, m.wonMax)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
    <LabSection
      id="section-management"
      title="관리비"
      meta={
        showSelectedEstimate && estimate ? (
          <>
            기준월 {formatMonthKo(estimate.latestMonth)}
            {" · "}
            전용 {estimate.exclusiveAreaMin.toFixed(2)}~
            {estimate.exclusiveAreaMax.toFixed(2)}㎡
          </>
        ) : undefined
      }
    >

      {showSelectedEstimate && estimate ? (
        <>
          <div className="detail-rows">
            <MetricRow
              label="최근 예상 관리비"
              emphasize
              valueLabel={formatWonRangeAsManwon(
                estimate.latest.wonMin,
                estimate.latest.wonMax,
              )}
            />
            <div
              className="border-t border-[color:var(--lab-border)]"
              role="separator"
              aria-hidden
            />
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
            <div className={`${LAB_SUBSECTION_RULE} flex flex-col gap-3`}>
              <LabSubsectionHeader title="관리비 구성" />
              <div className="detail-rows">
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

          <MgmtFeeMonthlyBars monthly={estimate.monthly} />

          <LabDisclosure
            title="관리비 산정근거 보기"
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
          <div>
            <p className="detail-meta">선택 평형 예상 관리비</p>
            <p className="detail-summary-value mt-1">
              평형별 관리비 데이터 준비 중
            </p>
          </div>

          <LabDisclosure
            title="관리비 산정근거 보기"
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
    </LabSection>
  );
}

/** K-apt 관리비 공개 의무 대상 기준(세대수) — 이보다 작으면 공개하지 않는 단지가 많다 */
const KAPT_DISCLOSURE_MIN_HOUSEHOLDS = 150;

/**
 * 관리비 자료가 없는 단지 — 영역을 숨기지 않고 왜 없는지 알려 준다(상단 '관리비' 탭이 빈 곳으로 가지 않게).
 * 소규모 단지는 공개 의무가 없어 자료가 없을 수 있고, 그 밖엔 아직 불러오지 못한 것이다.
 */
export function ComplexMgmtFeeEmpty({ householdCount }: { householdCount: number | null }) {
  const small = householdCount != null && householdCount > 0 && householdCount < KAPT_DISCLOSURE_MIN_HOUSEHOLDS;
  return (
    <LabSection
      id="section-management"
      title="관리비"
      tip={
        <p>
          관리비는 공동주택관리정보시스템(K-apt)에 단지가 공개한 월별 관리비로 보여 드립니다. 150세대 이상 등 의무관리대상
          단지가 공개하며, 그보다 작은 단지는 공개하지 않는 경우가 많습니다.
        </p>
      }
    >
      <div>
        <p className="detail-summary-value">관리비 정보가 없어요</p>
        <p className="detail-body mt-1">
          {small
            ? `이 단지는 ${householdCount!.toLocaleString("ko-KR")}세대 규모로 관리비 공개 의무 대상(150세대 이상 등)이 아니어서, 공개된 관리비 자료가 없습니다.`
            : "이 단지의 공개 관리비 자료를 아직 불러오지 못했어요. 자료가 확인되는 대로 채워 드릴게요."}
        </p>
      </div>
    </LabSection>
  );
}
