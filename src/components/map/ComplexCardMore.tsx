import { shortEok } from "@/components/map/complex-marker";
import type { MapComplex } from "@/lib/map/map-complexes";

/** 단지 카드 '더보기' — 전세가율·갭·월세수익률·1년 변동 (2D·3D 지도 같은 모양) */
export function ComplexCardMore({
  c,
  id,
}: {
  c: Pick<MapComplex, "jeonseRatioPct" | "gapMan" | "rentYieldPct" | "change1yPct">;
  id: string;
}) {
  const items: Array<[string, string | null, string | null]> = [
    ["전세가율", c.jeonseRatioPct != null ? `${c.jeonseRatioPct}%` : null, null],
    ["갭", c.gapMan != null ? `${c.gapMan < 0 ? "−" : ""}${shortEok(Math.abs(c.gapMan))}` : null, null],
    ["월세수익률", c.rentYieldPct != null ? `${c.rentYieldPct}%` : null, null],
    [
      "1년 변동",
      c.change1yPct != null
        ? `${c.change1yPct > 0 ? "+" : c.change1yPct < 0 ? "−" : ""}${Math.abs(c.change1yPct).toFixed(1)}%`
        : null,
      c.change1yPct == null || c.change1yPct === 0 ? null : c.change1yPct > 0 ? "#D93A3F" : "#2F62D6",
    ],
  ];
  return (
    <dl className="mt-2 grid grid-cols-4 gap-1 border-t border-[color:var(--lab-border)] pt-2 text-center" id={id}>
      {items.map(([label, value, color]) => (
        <div key={label} className="min-w-0">
          <dt className="whitespace-nowrap text-[12px] leading-4 text-[color:var(--lab-muted)]">{label}</dt>
          <dd
            className="whitespace-nowrap text-[14px] font-semibold leading-5 tabular-nums text-[color:var(--lab-navy-950)]"
            style={color ? { color } : undefined}
          >
            {value ?? "–"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
