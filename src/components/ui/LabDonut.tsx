import type { ReactNode } from "react";

export type LabDonutSegment = {
  key: string;
  value: number;
  color: string;
  /** Fade when another segment is the current choice. */
  dimmed?: boolean;
  /** Short on-slice label (e.g. "33평"); the share % is added under it. Empty string = % only. */
  label?: string;
};

/** Slices smaller than this carry no on-slice label (legend still lists them). */
const MIN_LABEL_SHARE = 0.08;
const HOLE_INSET = 0.22;

/** White or navy text on a slice — whichever has the higher contrast ratio. */
function inkFor(hex: string): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return "var(--lab-navy-950)";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const NAVY_LUM = 0.0105; // #0F172A
  const onWhite = 1.05 / (lum + 0.05);
  const onNavy = (lum + 0.05) / (NAVY_LUM + 0.05);
  return onWhite >= onNavy ? "#FFFFFF" : "var(--lab-navy-950)";
}

/**
 * 구성비 도넛 (policy §12.7). 큰 조각에는 이름·비율을 직접 쓰고, 전체 수치는 옆 목록에 둔다.
 * 도넛은 aria-hidden — 접근 가능한 수치는 목록이 담당한다. 조각 사이 흰 틈으로 인접 색을 구분한다.
 */
export function LabDonut({
  segments,
  centerLabel,
  centerValue,
  size = 184,
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
  const GAP = gaps && segments.length > 1 ? 0.6 : 0;
  let cursor = 0;
  const stops: string[] = [];
  const labels: Array<{ key: string; x: number; y: number; text: string; pct: number; ink: string }> = [];
  // Label sits mid-ring: between the outer edge and the hole.
  const ringMid = (0.5 + (0.5 - HOLE_INSET)) / 2;

  for (const seg of segments) {
    const share = Math.max(0, seg.value) / total;
    const pct = share * 100;
    const end = cursor + pct;
    const color = seg.dimmed ? `color-mix(in srgb, ${seg.color} 40%, white)` : seg.color;
    stops.push(`${color} ${cursor}% ${Math.max(cursor, end - GAP)}%`);
    if (GAP) stops.push(`#fff ${Math.max(cursor, end - GAP)}% ${end}%`);
    if (seg.label != null && share >= MIN_LABEL_SHARE) {
      // conic-gradient starts at 12 o'clock and runs clockwise.
      const angle = ((cursor + pct / 2) / 100) * 2 * Math.PI;
      labels.push({
        key: seg.key,
        x: 0.5 + ringMid * Math.sin(angle),
        y: 0.5 - ringMid * Math.cos(angle),
        text: seg.label,
        pct: Math.round(pct),
        ink: seg.dimmed ? "var(--lab-navy-950)" : inkFor(seg.color),
      });
    }
    cursor = end;
  }

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${stops.join(", ")})` }}
      />
      <div
        className="absolute flex flex-col items-center justify-center rounded-full bg-[color:var(--lab-surface)] text-center"
        style={{ inset: `${HOLE_INSET * 100}%` }}
      >
        {centerLabel ? <span className="detail-meta">{centerLabel}</span> : null}
        {centerValue ? (
          <span className="detail-data-value-emphasis tabular-nums">{centerValue}</span>
        ) : null}
      </div>
      {labels.map((l) => (
        <span
          key={l.key}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center whitespace-nowrap text-center text-[13px] font-semibold leading-4 tabular-nums"
          style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, color: l.ink }}
        >
          {l.text ? <span>{l.text}</span> : null}
          <span className={l.text ? "font-medium" : undefined}>{l.pct}%</span>
        </span>
      ))}
    </div>
  );
}
