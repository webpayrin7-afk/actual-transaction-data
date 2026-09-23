"use client";

import type { ReactNode } from "react";
import type { TrendPeriod } from "@/lib/market/trends-regions";
import { TREND_PERIOD_MONTHS } from "@/lib/market/trends-regions";

/** 정책 §4 차트 계열색 */
export const CHART_TRADE = "#087F83";
export const CHART_JEONSE = "#C2410C";
export const CHART_VOLUME = "#0F766E";
export const CHART_UP = "#B91C1C";
export const CHART_DOWN = "#1D4ED8";
export const CHART_TICK = { fontSize: 12, fill: "#64748b" };
export const CHART_AXIS_LINE = { stroke: "#e2e8f0" };
/** 모바일 플롯 220 / PC 280 (정책 §7) */
export const CHART_BOX = "h-[220px] w-full lg:h-[280px]";

export function ymDot(ym: string): string {
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

export function ymKorean(ym: string): string {
  return `${ym.slice(0, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

export function ymIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

export function ymFromIndex(i: number): string {
  return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`;
}

export function ymShift(ym: string, months: number): string {
  return ymFromIndex(ymIndex(ym) + months);
}

/** 마지막 점 기준으로 기간만큼 자른다. */
export function sliceByPeriod<T extends { ym: string }>(rows: T[], period: TrendPeriod): T[] {
  const months = TREND_PERIOD_MONTHS[period];
  if (!months || rows.length === 0) return rows;
  const last = rows.at(-1)!.ym;
  const from = ymShift(last, -months);
  return rows.filter((r) => r.ym >= from);
}

/** 연도 눈금: 1월 라벨만, 기간이 길면 2~4년 간격. */
export function yearTicks(rows: Array<{ ym: string }>): string[] {
  if (rows.length === 0) return [];
  const years = rows.length / 12;
  const step = years <= 6 ? 1 : years <= 12 ? 2 : 4;
  const januaries = rows.filter((r) => r.ym.endsWith("01")).map((r) => r.ym);
  const lastYear = Number(rows.at(-1)!.ym.slice(0, 4));
  return januaries.filter((ym) => (lastYear - Number(ym.slice(0, 4))) % step === 0);
}

/** 정리된 눈금(1·2·2.5·5 × 10^n)으로 min~max를 4칸 안팎으로 나눈다. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function signedPct(pct: number | null | undefined, digits = 1): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const v = pct.toFixed(digits);
  if (Number(v) === 0) return `0${digits ? "." + "0".repeat(digits) : ""}%`;
  return `${pct > 0 ? "+" : "−"}${v.replace("-", "")}%`;
}

export function toneOf(pct: number | null | undefined): "up" | "down" | "neutral" {
  if (pct == null || !Number.isFinite(pct) || Number(pct.toFixed(1)) === 0) return "neutral";
  return pct > 0 ? "up" : "down";
}

export function srTone(pct: number | null | undefined): string | undefined {
  const t = toneOf(pct);
  return t === "up" ? " 상승" : t === "down" ? " 하락" : undefined;
}

/** 만원 → "8.9억" / "9,800만" */
export function formatManwonShort(manwon: number): string {
  if (!Number.isFinite(manwon)) return "—";
  if (manwon >= 10000) {
    const eok = manwon / 10000;
    return `${eok >= 10 ? eok.toFixed(1) : eok.toFixed(2)}억`.replace(/\.?0+억$/, "억");
  }
  return `${Math.round(manwon).toLocaleString("ko-KR")}만`;
}

export type TooltipRow = { key: string; name: string; color: string; value: string };

/** 차트 툴팁 — 14px, 가장자리에서 잘리지 않게 max-width 제한 (정책 §7). */
export function ChartTooltipBox({ title, rows }: { title: string; rows: TooltipRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="max-w-[min(280px,calc(100vw-32px))] rounded-xl border border-[color:var(--lab-border)] bg-white px-3 py-2 text-[14px] leading-5 shadow-md">
      <p className="font-semibold text-[color:var(--lab-navy-950)] tabular-nums">{title}</p>
      {rows.map((r) => (
        <p key={r.key} className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap tabular-nums text-[color:var(--lab-body)]">
          <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} aria-hidden />
          {r.name}
          <span className="ml-auto pl-3 font-semibold text-[color:var(--lab-navy-950)]">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

/** 범례 한 줄 (13px) — 선/막대 모양을 함께 보여 색만으로 구분하지 않는다. */
export function ChartLegend({
  items,
}: {
  items: Array<{ key: string; label: ReactNode; color: string; shape: "line" | "bar" | "dash" }>;
}) {
  return (
    <p className="detail-meta flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1">
          {it.shape === "bar" ? (
            <span className="h-2 w-3 rounded-sm" style={{ background: it.color, opacity: 0.35 }} aria-hidden />
          ) : it.shape === "dash" ? (
            <span className="w-3 border-t-2 border-dashed" style={{ borderColor: it.color }} aria-hidden />
          ) : (
            <span className="h-0.5 w-3 rounded" style={{ background: it.color }} aria-hidden />
          )}
          {it.label}
        </span>
      ))}
    </p>
  );
}

export function ChartSkeleton() {
  return <div className={`${CHART_BOX} animate-pulse rounded-lg bg-slate-100`} aria-hidden />;
}

export function SectionError({ onRetry, children }: { onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="lab-state lab-state-error">
        {children ?? "자료를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."}
      </p>
      {onRetry ? (
        <button type="button" className="lab-button lab-button-secondary w-full" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
