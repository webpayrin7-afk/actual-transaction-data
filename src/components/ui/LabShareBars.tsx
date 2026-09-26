"use client";

import { useState, type ReactNode } from "react";
import { LAB_LIST } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

export type LabShareBarItem = {
  key: string;
  /** 항목 이름 (e.g. "일반고", "33평") */
  label: ReactNode;
  /** 이름 아래 보조 (e.g. 전용면적) */
  meta?: ReactNode;
  value: number;
  /** 원천이 준 비율(%) — 있으면 계산 대신 이 값을 표시·막대 길이로 쓴다 (항목 합이 100이 아닐 때). */
  percent?: number | null;
  /** 오른쪽 보조 수치 (e.g. "266명", "1,150세대") */
  sub?: ReactNode;
  /** 누르면 실행 (e.g. 이 평형 선택) */
  onClick?: () => void;
  selected?: boolean;
};

const DEFAULT_COLOR = "var(--lab-brand-primary)";

/**
 * 구성비 가로 막대 (policy §12.7) — 항목마다 한 줄: 이름 · 비율 · 보조 수치 + 전체 대비 길이 막대.
 * 작은 비율도 이름·수치 자리가 같아 도넛보다 읽기 쉽다. 5개 + 더보기 (policy §12.4).
 * `sort`: "value"면 큰 순, "none"이면 받은 순서 그대로 (평형처럼 순서가 의미 있을 때).
 */
export function LabShareBars({
  items,
  sort = "value",
  moreLabel = (n: number) => `${n}개 더보기`,
  color = DEFAULT_COLOR,
}: {
  items: LabShareBarItem[];
  sort?: "value" | "none";
  moreLabel?: (hidden: number) => string;
  color?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (total <= 0) return null;
  const ordered = sort === "value" ? [...items].sort((a, b) => b.value - a.value) : items;
  const visible = expanded ? ordered : ordered.slice(0, LAB_LIST_PREVIEW);
  const hidden = ordered.length - LAB_LIST_PREVIEW;

  return (
    <>
      <ul className={LAB_LIST}>
        {visible.map((item) => {
          const share = item.percent != null ? item.percent / 100 : item.value / total;
          const pct = item.percent != null ? item.percent : Math.round(share * 100);
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p
                    className="detail-data-value-emphasis truncate"
                    style={item.selected ? { color: "var(--lab-brand-primary)" } : undefined}
                  >
                    {item.label}
                  </p>
                  {item.meta ? <p className="detail-meta truncate">{item.meta}</p> : null}
                </div>
                <p className="shrink-0 whitespace-nowrap text-right tabular-nums">
                  <span className="detail-data-value-emphasis">{pct < 1 ? "<1" : pct}%</span>
                  {item.sub ? <span className="detail-meta ml-1.5">{item.sub}</span> : null}
                </p>
              </div>
              <div
                className="mt-1.5 h-2 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
                aria-hidden
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(1.5, share * 100)}%`,
                    background: color,
                    opacity: item.selected === false ? 0.45 : 1,
                  }}
                />
              </div>
            </>
          );
          return (
            <li key={item.key}>
              {item.onClick ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  aria-pressed={item.selected ?? false}
                  className="block min-h-11 w-full py-2.5 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]"
                >
                  {body}
                </button>
              ) : (
                <div className="py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          label={moreLabel(hidden)}
        />
      ) : null}
    </>
  );
}
