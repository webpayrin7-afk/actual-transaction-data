/** 방향(오름·보합·내림) 공통 색 — 범례·막대·숫자에 같은 매핑을 쓴다 (policy §12.6). */
export const LAB_DIRECTION_SEGMENTS = [
  { key: "up", label: "오름", color: "var(--lab-change-up)", cls: "detail-change-up" },
  { key: "other", label: "보합·기타", color: "#CBD5E1", cls: "" },
  { key: "down", label: "내림", color: "var(--lab-change-down)", cls: "detail-change-down" },
] as const;

export type LabBarSegment = { key: string; value: number; color: string };

/**
 * 구성비 누적 막대. `widthPct`로 행 간 규모 비교(같은 스케일), 내부는 구성비.
 * 장식용이므로 aria-hidden — 수치는 옆 텍스트로 반드시 함께 제공한다.
 */
export function LabStackedBar({
  segments,
  widthPct = 100,
  className = "h-2",
}: {
  segments: LabBarSegment[];
  widthPct?: number;
  className?: string;
}) {
  const sum = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div
      className={`overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)] ${className}`}
      aria-hidden
    >
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${widthPct}%` }}>
        {segments.map((seg) =>
          seg.value > 0 && sum > 0 ? (
            <span
              key={seg.key}
              className="h-full"
              style={{ width: `${(seg.value / sum) * 100}%`, background: seg.color }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

export function directionSegments(row: { up: number; down: number; other: number }): LabBarSegment[] {
  return LAB_DIRECTION_SEGMENTS.map((d) => ({ key: d.key, value: row[d.key], color: d.color }));
}
