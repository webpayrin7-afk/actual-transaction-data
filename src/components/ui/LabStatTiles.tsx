import type { ReactNode } from "react";

export type LabStatTone = "up" | "down" | "neutral";

export type LabStatTile = {
  key: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: LabStatTone;
  /** Screen-reader suffix, e.g. " 상승". */
  srValue?: string;
};

const TONE_CLASS: Record<LabStatTone, string> = {
  up: "detail-change-up",
  down: "detail-change-down",
  neutral: "",
};

const COLS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
};

/**
 * 테두리 박스 지표 묶음 (policy §12.4).
 * - stack: 라벨 위 · 값 아래(+보조), 값은 박스 하단 정렬 — 2~3개 요약 지표
 * - inline: 라벨 왼쪽 · 값 오른쪽 한 줄 — 변화율처럼 짧은 값 4개
 */
export function LabStatTiles({
  items,
  columns = 3,
  layout = "stack",
  loading = false,
  className = "",
}: {
  items: LabStatTile[];
  columns?: 2 | 3 | 4;
  layout?: "stack" | "inline";
  loading?: boolean;
  className?: string;
}) {
  return (
    <dl className={`grid gap-2 ${COLS[columns]} ${className}`.trim()}>
      {items.map((t) => {
        const tone = TONE_CLASS[t.tone ?? "neutral"];
        const value = loading ? (
          <span className="inline-block h-5 w-12 animate-pulse rounded bg-slate-100 align-middle" />
        ) : (
          <>
            {t.value}
            {t.srValue ? <span className="sr-only">{t.srValue}</span> : null}
          </>
        );
        if (layout === "inline") {
          return (
            <div
              key={t.key}
              className="flex min-w-0 items-baseline justify-between gap-2 rounded-xl border border-[color:var(--lab-border)] px-3 py-2.5"
            >
              <dt className="detail-label whitespace-nowrap">{t.label}</dt>
              <dd className={`detail-data-value-emphasis whitespace-nowrap ${tone}`}>{value}</dd>
            </div>
          );
        }
        return (
          <div
            key={t.key}
            className="flex min-w-0 flex-col justify-between gap-1 rounded-xl border border-[color:var(--lab-border)] px-2.5 py-2.5"
          >
            <dt className="detail-label break-keep">{t.label}</dt>
            <dd className="tabular-nums">
              <span className={`detail-data-value-emphasis block ${tone}`}>{value}</span>
              {t.sub && !loading ? <span className="detail-meta block break-keep">{t.sub}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
