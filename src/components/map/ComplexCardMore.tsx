import { shortEok } from "@/components/map/complex-marker";
import type { MapComplex } from "@/lib/map/map-complexes";

/**
 * 단지 카드 '더보기' — 최근 12개월 거래 범위·건수, 전세가율·갭·월세수익률·1년 변동을
 * 같은 크기 칸 3×2로 (2D·3D 지도 같은 모양)
 */
export function ComplexCardMore({
  c,
  id,
}: {
  c: Pick<MapComplex, "jeonseRatioPct" | "gapMan" | "rentYieldPct" | "change1yPct"> &
    Partial<Pick<MapComplex, "rangeMinMan" | "rangeMaxMan" | "tradeCount12m">>;
  id: string;
}) {
  const range =
    c.rangeMinMan != null && c.rangeMaxMan != null
      ? c.rangeMinMan === c.rangeMaxMan
        ? shortEok(c.rangeMinMan)
        : `${shortEok(c.rangeMinMan)}~${shortEok(c.rangeMaxMan)}`
      : null;
  const items: Array<[string, string | null, string | null]> = [
    ["12개월 거래가", range, null],
    ["12개월 거래", c.tradeCount12m ? `${c.tradeCount12m}건` : null, null],
    [
      "1년 변동",
      c.change1yPct != null
        ? `${c.change1yPct > 0 ? "+" : c.change1yPct < 0 ? "−" : ""}${Math.abs(c.change1yPct).toFixed(1)}%`
        : null,
      c.change1yPct == null || c.change1yPct === 0 ? null : c.change1yPct > 0 ? "#D93A3F" : "#2F62D6",
    ],
    ["전세가율", c.jeonseRatioPct != null ? `${c.jeonseRatioPct}%` : null, null],
    ["갭", c.gapMan != null ? `${c.gapMan < 0 ? "−" : ""}${shortEok(Math.abs(c.gapMan))}` : null, null],
    ["월세수익률", c.rentYieldPct != null ? `${c.rentYieldPct}%` : null, null],
  ];
  return (
    <dl id={id} className="mb-1 mt-2 grid grid-cols-3 gap-1.5">
      {items.map(([label, value, color]) => (
        <div key={label} className="min-w-0 rounded-lg bg-[color:var(--lab-surface-subtle)] px-2 py-1.5 text-center">
          <dt className="truncate text-[12px] leading-4 text-[color:var(--lab-muted)]">{label}</dt>
          <dd
            className="truncate text-[14px] font-semibold leading-5 tabular-nums text-[color:var(--lab-navy-950)]"
            style={color ? { color } : undefined}
          >
            {value ?? "–"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
