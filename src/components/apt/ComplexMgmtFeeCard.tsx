"use client";

import { useMemo } from "react";
import { LabCard } from "@/components/ui/lab";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import {
  computeSeasonMetric,
  formatWonAsManwon,
  formatYyyymmBasisLabel,
  formatYyyymmLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";
import {
  MANAGEMENT_AREA_FEE_CLASSIFICATION,
  MANAGEMENT_AREA_FEE_NOTE,
} from "@/lib/complex-detail/source-status";

function MetricRow({
  label,
  valueWon,
  hint,
  emphasize,
}: {
  label: string;
  valueWon: number | null;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <div className="min-w-0">
        <p
          className={
            emphasize
              ? "text-sm font-medium text-slate-700"
              : "text-sm text-slate-600"
          }
        >
          {label}
        </p>
        {hint ? (
          <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>
        ) : null}
      </div>
      <p
        className={
          emphasize
            ? "shrink-0 text-lg font-bold tabular-nums tracking-tight text-slate-900"
            : "shrink-0 text-sm font-semibold tabular-nums text-slate-800"
        }
      >
        {formatWonAsManwon(valueWon)}
      </p>
    </div>
  );
}

/**
 * Management-fee summary for Complex Detail.
 *
 * Selected-pyeong fees require an official area unit price (AREA_FEE_SAFE).
 * Until then, do not present complex-total ÷ households as the selected 평형 bill.
 * Complex average is demoted to a labeled reference only.
 */
export function ComplexMgmtFeeCard({
  management,
  selectedPyeongLabel,
}: {
  management: ComplexManagementV1;
  /** e.g. "33평" when an area group is selected; omit/"전체" when none. */
  selectedPyeongLabel?: string | null;
}) {
  const { latest, average, householdCount, monthlySeries, averageLabel } =
    management;

  const winter = useMemo(
    () => computeSeasonMetric(monthlySeries, latest.periodYyyymm, "winter"),
    [monthlySeries, latest.periodYyyymm],
  );
  const summer = useMemo(
    () => computeSeasonMetric(monthlySeries, latest.periodYyyymm, "summer"),
    [monthlySeries, latest.periodYyyymm],
  );

  const latestPerHh = latest.perHouseholdComponentSum;
  const avgPerHh = average.perHouseholdComponentSum;
  const commonPerHh =
    average.commonFee != null
      ? Math.round(average.commonFee / householdCount)
      : null;
  const individualPerHh =
    average.individualFee != null
      ? Math.round(average.individualFee / householdCount)
      : null;
  const reservePerHh =
    average.longTermRepairReserve != null
      ? Math.round(average.longTermRepairReserve / householdCount)
      : null;

  const winterHint =
    winter.valueWon == null
      ? "자료 부족"
      : winter.monthsUsed.length < 3
        ? `${winter.monthsUsed.length}개월 평균`
        : undefined;
  const summerHint =
    summer.valueWon == null
      ? "자료 부족"
      : summer.monthsUsed.length < 3
        ? `${summer.monthsUsed.length}개월 평균`
        : undefined;

  const areaFeeSafe =
    MANAGEMENT_AREA_FEE_CLASSIFICATION === "AREA_FEE_OFFICIAL" ||
    MANAGEMENT_AREA_FEE_CLASSIFICATION === "AREA_FEE_DERIVABLE_SAFE";

  const pyeongTitle =
    selectedPyeongLabel && selectedPyeongLabel !== "전체"
      ? selectedPyeongLabel
      : null;

  const subtitle = areaFeeSafe
    ? pyeongTitle
      ? `${pyeongTitle} 기준`
      : "선택 평형 기준"
    : pyeongTitle
      ? `${pyeongTitle} · 면적단가 확인 중`
      : "선택 평형 · 면적단가 확인 중";

  return (
    <LabCard className="p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
          관리비
        </h2>
        <p className="shrink-0 text-xs font-medium text-slate-500 sm:text-sm">
          {subtitle}
        </p>
      </div>

      {!areaFeeSafe ? (
        <div className="mt-3">
          <p className="text-sm text-slate-600">선택 평형 예상 관리비</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            평형별 관리비 데이터 확인 중
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            공동주택관리정보(K-apt) 승인 API는 단지·월 총액만 제공하며, 공식
            면적단가(원/㎡) 및 기준면적이 확정되지 않아 선택 평형 금액을
            계산하지 않습니다.
          </p>
        </div>
      ) : null}

      <div
        className={
          areaFeeSafe
            ? "mt-3"
            : "mt-4 rounded-md border border-slate-200/90 bg-slate-50/80 px-3 py-3"
        }
      >
        {!areaFeeSafe ? (
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            단지 참고값 · 세대당 평균
          </p>
        ) : null}
        <p
          className={
            areaFeeSafe
              ? "text-sm text-slate-600"
              : "mt-1 text-sm text-slate-600"
          }
        >
          {areaFeeSafe ? "최근 예상 관리비" : "최근 단지 세대당 평균"}
        </p>
        <p
          className={
            areaFeeSafe
              ? "mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900"
              : "mt-1 text-lg font-semibold tabular-nums tracking-tight text-slate-800"
          }
        >
          {formatWonAsManwon(latestPerHh)}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          단지 총액÷전체 세대수 단순 환산 ·{" "}
          {formatYyyymmBasisLabel(latest.periodYyyymm)}
          {!areaFeeSafe
            ? " · 선택 평형 관리비로 사용하지 않습니다"
            : null}
        </p>
      </div>

      <div className="mt-4 border-t border-slate-200/80 pt-1">
        <MetricRow
          label={areaFeeSafe ? "겨울 평균" : "겨울 평균 (단지 참고)"}
          valueWon={winter.valueWon}
          hint={winterHint}
        />
        <MetricRow
          label={areaFeeSafe ? "여름 평균" : "여름 평균 (단지 참고)"}
          valueWon={summer.valueWon}
          hint={summerHint}
        />
        <MetricRow
          label={areaFeeSafe ? "최근 평균" : "최근 평균 (단지 참고)"}
          valueWon={avgPerHh}
          hint={averageLabel}
        />
      </div>

      <div className="mt-2 border-t border-slate-200/80 pt-1">
        <p className="pt-2 text-sm font-medium text-slate-800">
          {areaFeeSafe ? "관리비 구성" : "관리비 구성 (단지 참고)"}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {averageLabel} · 세대당 단순 환산
          {!areaFeeSafe ? " · 선택 평형 구성 아님" : ""}
        </p>
        <div className="mt-1">
          <MetricRow label="공용관리비" valueWon={commonPerHh} />
          <MetricRow label="개별사용료" valueWon={individualPerHh} />
          <MetricRow label="장기수선충당금" valueWon={reservePerHh} />
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-slate-600">
        {!areaFeeSafe
          ? "선택 평형 관리비는 공식 면적단가가 확인된 뒤에만 표시합니다. 아래 단지 참고값은 단지 전체 관리비를 세대수로 나눈 단순 환산이며, 선택 평형의 예상·실제 부과액이 아닙니다."
          : "공동주택관리정보의 공식 면적단가를 선택 평형에 적용한 예상값입니다. 실제 세대별 부과액은 사용량 등에 따라 달라질 수 있습니다."}
      </p>

      <LabDisclosure title="계산 기준 및 세부내역" className="mt-3">
        <ul className="space-y-2 text-sm leading-relaxed text-slate-700">
          <li>{management.disclaimer}</li>
          <li>
            공용관리비 · 개별사용료 · 장기수선충당금은 공식 단지 월 합계를
            세대수({householdCount.toLocaleString("ko-KR")})로 나눈 값입니다.
          </li>
          <li>
            겨울은 12·1·2월, 여름은 6·7·8월 중 최신 qualifying season 평균입니다.
            {winter.monthsUsed.length
              ? ` 겨울 표본: ${winter.monthsUsed.map(formatYyyymmLabel).join(", ")}.`
              : ""}
            {summer.monthsUsed.length
              ? ` 여름 표본: ${summer.monthsUsed.map(formatYyyymmLabel).join(", ")}.`
              : ""}
          </li>
          <li>{averageLabel}은 최근 연속 최대 12개월입니다.</li>
          <li>{MANAGEMENT_AREA_FEE_NOTE}</li>
        </ul>
      </LabDisclosure>
    </LabCard>
  );
}
