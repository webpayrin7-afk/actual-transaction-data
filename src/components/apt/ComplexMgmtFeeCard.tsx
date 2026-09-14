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
import { MANAGEMENT_AREA_FEE_NOTE } from "@/lib/complex-detail/source-status";

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

function prevYyyymm(yyyymm: string): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  if (m <= 1) return `${y - 1}12`;
  return `${y}${String(m - 1).padStart(2, "0")}`;
}

function yoyYyyymm(yyyymm: string): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = yyyymm.slice(4, 6);
  return `${y - 1}${m}`;
}

/**
 * Management-fee summary for Complex Detail.
 * Values are per-household simple conversions (단지총액 ÷ 세대수).
 * No chart; no area/pyeong inventing.
 */
export function ComplexMgmtFeeCard({
  management,
}: {
  management: ComplexManagementV1;
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

  const comparisons = useMemo(() => {
    if (latestPerHh == null || latestPerHh <= 0) return [];
    const byYm = new Map<string, number>();
    for (const m of monthlySeries) {
      if (
        m.perHouseholdComponentSum != null &&
        m.perHouseholdComponentSum > 0
      ) {
        byYm.set(m.periodYyyymm, m.perHouseholdComponentSum);
      }
    }
    const out: { label: string; deltaWon: number }[] = [];
    const prev = byYm.get(prevYyyymm(latest.periodYyyymm));
    if (prev != null) {
      out.push({ label: "전월 대비", deltaWon: latestPerHh - prev });
    }
    const yoy = byYm.get(yoyYyyymm(latest.periodYyyymm));
    if (yoy != null) {
      out.push({ label: "전년동월 대비", deltaWon: latestPerHh - yoy });
    }
    return out;
  }, [monthlySeries, latest.periodYyyymm, latestPerHh]);

  return (
    <LabCard className="p-4 sm:p-5">
      <h2 className="text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
        관리비
      </h2>

      <div className="mt-3">
        <p className="text-sm text-slate-600">최근 관리비</p>
        <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900">
          {formatWonAsManwon(latestPerHh)}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          세대당 단순 환산 · {formatYyyymmBasisLabel(latest.periodYyyymm)}
        </p>
        {comparisons.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {comparisons.map((c) => {
              const sign = c.deltaWon > 0 ? "+" : c.deltaWon < 0 ? "-" : "";
              const abs = formatWonAsManwon(Math.abs(c.deltaWon));
              return (
                <span key={c.label} className="tabular-nums">
                  {c.label} {sign}
                  {abs === "—" ? "0만원" : abs}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="mt-4 border-t border-slate-200/80 pt-1">
        <MetricRow
          label="겨울 평균"
          valueWon={winter.valueWon}
          hint={winterHint}
        />
        <MetricRow
          label="여름 평균"
          valueWon={summer.valueWon}
          hint={summerHint}
        />
        <MetricRow label="최근 평균" valueWon={avgPerHh} hint={averageLabel} />
      </div>

      <div className="mt-2 border-t border-slate-200/80 pt-1">
        <p className="pt-2 text-sm font-medium text-slate-800">관리비 구성</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {averageLabel} · 세대당 단순 환산
        </p>
        <div className="mt-1">
          <MetricRow label="공용관리비" valueWon={commonPerHh} />
          <MetricRow label="개별사용료" valueWon={individualPerHh} />
          <MetricRow label="장기수선충당금" valueWon={reservePerHh} />
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-slate-600">
        단지 전체 관리비를 세대수로 나눈 단순 환산값입니다. 선택 평형의 실제
        관리비와는 다를 수 있습니다.
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
