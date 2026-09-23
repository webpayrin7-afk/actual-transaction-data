import type { ReactNode } from "react";

export type LabDonutSegment = {
  key: string;
  value: number;
  color: string;
  /** Fade when another segment is the current choice. */
  dimmed?: boolean;
  /** Name shown in the outside callout (e.g. "33평"). Empty/omitted = % only. */
  label?: string;
};

/** Slices smaller than this get no callout (the list still has them). */
const MIN_LABEL_SHARE = 0.04;
const HOLE_INSET = 0.22;
/** Width reserved on each side for callout text. */
const LABEL_W = 76;
/** Vertical room one callout needs (name + % lines). */
const LABEL_H = 30;
const LEADER_OUT = 10;
const ELBOW = 14;

type Callout = {
  key: string;
  side: "left" | "right";
  /** ring edge point */
  x1: number;
  y1: number;
  /** elbow point */
  x2: number;
  y2: number;
  /** resolved label y (after de-overlap) */
  y: number;
  name: string;
  pct: number;
};

/** Push callouts on one side apart so they never overlap; keep inside [minY, maxY]. */
function spread(list: Callout[], minY: number, maxY: number) {
  list.sort((a, b) => a.y - b.y);
  for (let i = 1; i < list.length; i++) {
    list[i]!.y = Math.max(list[i]!.y, list[i - 1]!.y + LABEL_H);
  }
  const overflow = list.length ? list[list.length - 1]!.y - maxY : 0;
  if (overflow > 0) {
    for (const c of list) c.y -= overflow;
    for (let i = list.length - 2; i >= 0; i--) {
      list[i]!.y = Math.min(list[i]!.y, list[i + 1]!.y - LABEL_H);
    }
  }
  for (const c of list) c.y = Math.max(minY, c.y);
}

/**
 * 구성비 도넛 (policy §12.7). 각 조각에서 선을 밖으로 빼 이름·비율을 표시한다 (조각 안에 쓰지 않음).
 * 도넛·선은 aria-hidden — 접근 가능한 수치는 옆 목록이 담당한다.
 */
export function LabDonut({
  segments,
  centerLabel,
  centerValue,
  size = 140,
  gaps = true,
}: {
  segments: LabDonutSegment[];
  centerLabel?: ReactNode;
  centerValue?: ReactNode;
  size?: number;
  /** White separators between slices (useful for same-hue ramps). */
  gaps?: boolean;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (total <= 0) return null;

  const W = size + LABEL_W * 2;
  const H = size + 24;
  const cx = W / 2;
  const cy = H / 2;
  const R = size / 2;
  const GAP = gaps && segments.length > 1 ? 0.6 : 0;

  let cursor = 0;
  const stops: string[] = [];
  const callouts: Callout[] = [];
  for (const seg of segments) {
    const share = Math.max(0, seg.value) / total;
    const pct = share * 100;
    const end = cursor + pct;
    const color = seg.dimmed ? `color-mix(in srgb, ${seg.color} 40%, white)` : seg.color;
    stops.push(`${color} ${cursor}% ${Math.max(cursor, end - GAP)}%`);
    if (GAP) stops.push(`#fff ${Math.max(cursor, end - GAP)}% ${end}%`);
    if (share >= MIN_LABEL_SHARE) {
      // conic-gradient starts at 12 o'clock and runs clockwise.
      const a = ((cursor + pct / 2) / 100) * 2 * Math.PI;
      const sin = Math.sin(a);
      const cos = Math.cos(a);
      const side = sin >= 0 ? "right" : "left";
      const x2 = cx + (R + LEADER_OUT) * sin;
      const y2 = cy - (R + LEADER_OUT) * cos;
      callouts.push({
        key: seg.key,
        side,
        x1: cx + R * sin,
        y1: cy - R * cos,
        x2,
        y2,
        y: y2,
        name: seg.label ?? "",
        pct: Math.round(pct),
      });
    }
    cursor = end;
  }

  const minY = LABEL_H / 2;
  const maxY = H - LABEL_H / 2;
  spread(callouts.filter((c) => c.side === "right"), minY, maxY);
  spread(callouts.filter((c) => c.side === "left"), minY, maxY);

  const textX = (c: Callout) => (c.side === "right" ? cx + R + ELBOW + 4 : cx - R - ELBOW - 4);

  return (
    <div className="relative shrink-0" style={{ width: W, height: H }} aria-hidden>
      <div
        className="absolute rounded-full"
        style={{
          left: cx - R,
          top: cy - R,
          width: size,
          height: size,
          background: `conic-gradient(${stops.join(", ")})`,
        }}
      />
      <div
        className="absolute flex flex-col items-center justify-center rounded-full bg-[color:var(--lab-surface)] text-center"
        style={{
          left: cx - R + size * HOLE_INSET,
          top: cy - R + size * HOLE_INSET,
          width: size * (1 - HOLE_INSET * 2),
          height: size * (1 - HOLE_INSET * 2),
        }}
      >
        {centerLabel ? <span className="detail-meta">{centerLabel}</span> : null}
        {centerValue ? (
          <span className="detail-data-value-emphasis tabular-nums">{centerValue}</span>
        ) : null}
      </div>

      <svg className="absolute inset-0" width={W} height={H} fill="none">
        {callouts.map((c) => (
          <polyline
            key={c.key}
            points={`${c.x1},${c.y1} ${c.x2},${c.y2} ${c.side === "right" ? cx + R + ELBOW : cx - R - ELBOW},${c.y}`}
            stroke="var(--lab-muted)"
            strokeWidth={1}
          />
        ))}
      </svg>

      {callouts.map((c) => (
        <div
          key={c.key}
          className={`absolute flex -translate-y-1/2 flex-col leading-4 ${
            c.side === "right" ? "items-start text-left" : "-translate-x-full items-end text-right"
          }`}
          style={{ left: textX(c), top: c.y, maxWidth: LABEL_W - ELBOW - 6 }}
        >
          {c.name ? (
            <span className="break-keep text-[12px] font-medium text-[color:var(--lab-body)]">{c.name}</span>
          ) : null}
          <span className="text-[13px] font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
            {c.pct}%
          </span>
        </div>
      ))}
    </div>
  );
}
