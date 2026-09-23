import type { ReactNode } from "react";

export type LabDonutSegment = {
  key: string;
  value: number;
  color: string;
  /** Fade when another segment is the current choice. */
  dimmed?: boolean;
};

/**
 * 구성비 도넛 (policy §12.7). 장식이므로 수치는 옆 목록에 반드시 함께 둔다 — 도넛 자체는 aria-hidden.
 * 조각 사이 흰 틈으로 인접 색을 구분한다.
 */
export function LabDonut({
  segments,
  centerLabel,
  centerValue,
  size = 148,
}: {
  segments: LabDonutSegment[];
  centerLabel?: ReactNode;
  centerValue?: ReactNode;
  size?: number;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) return null;
  const GAP = segments.length > 1 ? 0.6 : 0;
  let cursor = 0;
  const stops: string[] = [];
  for (const seg of segments) {
    const pct = (Math.max(0, seg.value) / total) * 100;
    const end = cursor + pct;
    const color = seg.dimmed ? `color-mix(in srgb, ${seg.color} 40%, white)` : seg.color;
    stops.push(`${color} ${cursor}% ${Math.max(cursor, end - GAP)}%`);
    if (GAP) stops.push(`#fff ${Math.max(cursor, end - GAP)}% ${end}%`);
    cursor = end;
  }

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${stops.join(", ")})` }}
      />
      <div className="absolute inset-[24%] flex flex-col items-center justify-center rounded-full bg-[color:var(--lab-surface)] text-center">
        {centerLabel ? <span className="detail-meta">{centerLabel}</span> : null}
        {centerValue ? (
          <span className="detail-data-value-emphasis tabular-nums">{centerValue}</span>
        ) : null}
      </div>
    </div>
  );
}
