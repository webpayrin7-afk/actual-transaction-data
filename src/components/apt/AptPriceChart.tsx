"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import type { AptChartPoint, AptHistoryItem } from "@/lib/molit/apt-client";
import type { TransactionTabType } from "@/lib/apt/transaction-type";
import { labSecondaryTabClass } from "@/components/ui/lab";
import { formatDealDate, formatEok, formatExclusiveArea } from "@/lib/utils/format";

/** Brand / accent hex for reliable SVG (match --lab-price-* / --lab-chart-*). */
const CHART_COLORS = {
  trade: "#087F83", // --lab-price-trade
  jeonse: "#C2410C", // --lab-price-jeonse
  deal: "#94A3B8",
  high: "#DC2626",
  low: "#2563EB",
  volume: "#CBD5E1",
} as const;

function seriesLineColor(dealType: TransactionTabType): string {
  return dealType === "jeonse" ? CHART_COLORS.jeonse : CHART_COLORS.trade;
}

type DealScatterPoint = {
  t: number;
  priceEok: number;
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  floor: number;
  kind: "deal" | "high" | "low";
  id: string;
};

type MonthSeriesPoint = {
  t: number;
  yearMonth: string;
  priceEok: number | null;
  volume: number;
};

function toEok(manwon: number | null | undefined): number | null {
  if (manwon == null || !Number.isFinite(manwon) || manwon <= 0) return null;
  return Math.round((manwon / 10000) * 100) / 100;
}

function formatYmLabel(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(2, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

function ymToMidTs(ym: string): number {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  return Date.UTC(y, m - 1, 15);
}

function ymToStartTs(ym: string): number {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  return Date.UTC(y, m - 1, 1);
}

function ymToEndTs(ym: string): number {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  return Date.UTC(y, m, 0, 23, 59, 59);
}

function dealDateToTs(dealDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dealDate.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function seriesAvgMan(
  point: AptChartPoint,
  dealType: TransactionTabType,
): number | null {
  if (dealType === "trade") return point.tradeAvg;
  if (dealType === "jeonse") return point.jeonseAvg;
  return null;
}

function seriesVolume(
  point: AptChartPoint,
  dealType: TransactionTabType,
): number {
  if (dealType === "trade") return point.tradeCount;
  if (dealType === "jeonse") return point.jeonseCount;
  return point.wolseCount;
}

function seriesLabel(dealType: TransactionTabType): string {
  if (dealType === "jeonse") return "전세 월평균";
  if (dealType === "monthly") return "시세";
  return "매매 월평균";
}

type ChartViewBox = Partial<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/**
 * Keep tooltip near the cursor; shift left only by the overflow past the
 * chart/view edge (not a full left flip).
 */
function TooltipBox({
  children,
  className,
  coordinate,
  viewBox,
}: {
  children: ReactNode;
  className: string;
  coordinate?: Partial<{ x: number; y: number }>;
  viewBox?: ChartViewBox;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || coordinate?.x == null || viewBox?.width == null) {
      setShiftX(0);
      return;
    }
    const width = el.offsetWidth;
    const pad = 8;
    const chartRight = (viewBox.x ?? 0) + viewBox.width;
    // Default placement grows to the right of the cursor/wrapper.
    const overflow = coordinate.x + pad + width - chartRight;
    setShiftX(overflow > 0 ? -Math.ceil(overflow) : 0);
  }, [children, coordinate?.x, coordinate?.y, viewBox?.width, viewBox?.x]);

  return (
    <div
      ref={ref}
      className={className}
      style={shiftX ? { transform: `translateX(${shiftX}px)` } : undefined}
    >
      {children}
    </div>
  );
}

/** Keep price + volume plot gutters identical so month X positions align. */
const PRICE_CHART_MARGIN = { top: 18, right: 6, left: 0, bottom: 4 } as const;
const VOLUME_CHART_MARGIN = { top: 2, right: 6, left: 34, bottom: 0 } as const;
const PRICE_Y_AXIS_WIDTH = 34;
/** Finger/cursor proximity for promoting 최고/최저 over nearby deals or the line. */
const EXTREME_HIT_RADIUS_PX = 28;
/** Period / filter changes replay chart draw. */
const CHART_ANIMATION_MS = 480;

type ExtremeHit = {
  id: string;
  kind: "high" | "low";
  x: number;
  y: number;
  point: DealScatterPoint;
};

type PriorityExtreme = {
  point: DealScatterPoint;
  x: number;
  y: number;
};

const TOOLTIP_BOX_CLASS =
  "w-max max-w-[min(14rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-md";

function DealScatterTooltip({
  row,
  coordinate,
  viewBox,
}: {
  row: DealScatterPoint;
  coordinate?: Partial<{ x: number; y: number }>;
  viewBox?: ChartViewBox;
}) {
  const tag =
    row.kind === "high" ? "최고" : row.kind === "low" ? "최저" : null;
  return (
    <TooltipBox
      className={TOOLTIP_BOX_CLASS}
      coordinate={coordinate}
      viewBox={viewBox}
    >
      {tag ? (
        <p
          className="mb-1 font-semibold"
          style={{
            color: row.kind === "high" ? CHART_COLORS.high : CHART_COLORS.low,
          }}
        >
          {tag}
        </p>
      ) : null}
      <p className="font-medium text-slate-800">{formatDealDate(row.dealDate)}</p>
      <ul className="mt-1.5 space-y-0.5 text-slate-600">
        <li className="flex justify-between gap-4">
          <span>거래가격</span>
          <span className="font-semibold tabular-nums text-slate-800">
            {formatEok(row.dealAmount)}
          </span>
        </li>
        <li className="flex justify-between gap-4">
          <span>전용면적</span>
          <span className="tabular-nums">{formatExclusiveArea(row.exclusiveArea)}</span>
        </li>
        <li className="flex justify-between gap-4">
          <span>층</span>
          <span className="tabular-nums">{row.floor}층</span>
        </li>
      </ul>
    </TooltipBox>
  );
}

function pickScatterFromPayload(
  payload: NonNullable<TooltipProps<number, string>["payload"]>,
): DealScatterPoint | null {
  // Prefer 최고/최저 when Recharts includes multiple scatter series at once.
  const extreme = payload.find((item) => {
    const kind = (item.payload as DealScatterPoint | undefined)?.kind;
    return kind === "high" || kind === "low";
  });
  if (extreme?.payload) return extreme.payload as DealScatterPoint;
  const any = payload.find(
    (item) =>
      item.payload &&
      typeof (item.payload as DealScatterPoint).kind === "string",
  );
  return any?.payload ? (any.payload as DealScatterPoint) : null;
}

function PriceChartTooltip({
  active,
  payload,
  coordinate,
  viewBox,
  priorityExtreme,
}: TooltipProps<number, string> & {
  priorityExtreme?: PriorityExtreme | null;
}) {
  if (priorityExtreme) {
    return (
      <DealScatterTooltip
        row={priorityExtreme.point}
        coordinate={{ x: priorityExtreme.x, y: priorityExtreme.y }}
        viewBox={viewBox as ChartViewBox | undefined}
      />
    );
  }

  if (!active || !payload?.length) return null;

  const scatter = pickScatterFromPayload(payload);
  if (scatter) {
    return (
      <DealScatterTooltip
        row={scatter}
        coordinate={coordinate}
        viewBox={viewBox as ChartViewBox | undefined}
      />
    );
  }

  const row = payload[0]?.payload as MonthSeriesPoint | undefined;
  if (!row) return null;
  const priceItem = payload.find((item) => item.dataKey === "priceEok");
  return (
    <TooltipBox
      className={TOOLTIP_BOX_CLASS}
      coordinate={coordinate}
      viewBox={viewBox as ChartViewBox | undefined}
    >
      <p className="mb-1.5 font-medium text-slate-800">
        {formatYmLabel(row.yearMonth)}
      </p>
      <p className="flex items-center justify-between gap-3 font-medium text-[color:var(--lab-teal-700)]">
        <span>{String(priceItem?.name ?? "시세")}</span>
        <span className="tabular-nums">
          {row.priceEok == null ? "—" : `${row.priceEok}억`}
        </span>
      </p>
    </TooltipBox>
  );
}

function VolumeTooltip({
  active,
  payload,
}: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as MonthSeriesPoint | undefined;
  if (!row) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm shadow-md">
      <p className="font-medium text-slate-700">{formatYmLabel(row.yearMonth)}</p>
      <p className="mt-0.5 tabular-nums text-slate-500">{row.volume}건</p>
    </div>
  );
}

function ExtremeDot(
  props: {
    cx?: number;
    cy?: number;
    payload?: DealScatterPoint;
    registerExtremeHit?: (hit: ExtremeHit) => void;
  },
) {
  const { cx, cy, payload, registerExtremeHit } = props;
  if (cx == null || cy == null || !payload) return null;
  const isExtreme = payload.kind === "high" || payload.kind === "low";
  if (isExtreme && registerExtremeHit) {
    registerExtremeHit({
      id: payload.id,
      kind: payload.kind as "high" | "low",
      x: cx,
      y: cy,
      point: payload,
    });
  }
  const fill =
    payload.kind === "high"
      ? CHART_COLORS.high
      : payload.kind === "low"
        ? CHART_COLORS.low
        : CHART_COLORS.deal;
  const r = payload.kind === "deal" ? 2.5 : 5;
  const label =
    payload.kind === "high" ? "최고" : payload.kind === "low" ? "최저" : null;
  return (
    <g>
      {isExtreme ? (
        <circle
          cx={cx}
          cy={cy}
          r={EXTREME_HIT_RADIUS_PX}
          fill="transparent"
          stroke="none"
          style={{ pointerEvents: "all" }}
        />
      ) : null}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={fill}
        fillOpacity={payload.kind === "deal" ? 0.45 : 0.95}
        stroke={payload.kind === "deal" ? "none" : "#fff"}
        strokeWidth={payload.kind === "deal" ? 0 : 1.5}
      />
      {label ? (
        <text
          x={cx}
          // 위에 자리가 없으면(차트 맨 위 점) 점 아래에
          y={cy < 22 ? cy + 18 : cy - 9}
          textAnchor="middle"
          fill={fill}
          fontSize={12}
          fontWeight={600}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function AptPriceChart({
  points,
  deals = [],
  dealType = "trade",
  dealCount,
  dealCountLabel,
  selectedMonthYm = null,
  onMonthSelect,
}: {
  points: AptChartPoint[];
  /** Period + area + deal-type filtered raw deals (one point per trade). */
  deals?: AptHistoryItem[];
  dealType?: TransactionTabType;
  /** Period deal count shown on the legend row (right). */
  dealCount?: number;
  dealCountLabel?: string;
  selectedMonthYm?: string | null;
  onMonthSelect?: (ym: string | null) => void;
}) {
  const extremeHitsRef = useRef<ExtremeHit[]>([]);
  const extremeKeyRef = useRef("");
  const [priorityState, setPriorityState] = useState<{
    key: string;
    value: PriorityExtreme | null;
  }>({ key: "", value: null });

  const registerExtremeHit = useCallback((hit: ExtremeHit) => {
    const hits = extremeHitsRef.current;
    const idx = hits.findIndex(
      (row) => row.id === hit.id && row.kind === hit.kind,
    );
    if (idx >= 0) hits[idx] = hit;
    else hits.push(hit);
  }, []);

  const clearPriorityExtreme = useCallback(() => {
    const key = extremeKeyRef.current;
    setPriorityState((prev) =>
      prev.key === key && prev.value == null
        ? prev
        : { key, value: null },
    );
  }, []);

  const handleChartMouseMove = useCallback(
    (state: { chartX?: number; chartY?: number } | null) => {
      const key = extremeKeyRef.current;
      if (!state || state.chartX == null || state.chartY == null) {
        setPriorityState((prev) =>
          prev.key === key && prev.value == null
            ? prev
            : { key, value: null },
        );
        return;
      }
      const { chartX, chartY } = state;
      let best: ExtremeHit | null = null;
      let bestDist = EXTREME_HIT_RADIUS_PX;
      for (const hit of extremeHitsRef.current) {
        const dist = Math.hypot(hit.x - chartX, hit.y - chartY);
        if (dist <= bestDist) {
          bestDist = dist;
          best = hit;
        }
      }
      setPriorityState((prev) => {
        if (!best) {
          return prev.key === key && prev.value == null
            ? prev
            : { key, value: null };
        }
        if (
          prev.key === key &&
          prev.value &&
          prev.value.point.id === best.point.id &&
          prev.value.point.kind === best.point.kind &&
          prev.value.x === best.x &&
          prev.value.y === best.y
        ) {
          return prev;
        }
        return {
          key,
          value: { point: best.point, x: best.x, y: best.y },
        };
      });
    },
    [],
  );

  const monthSeries = useMemo<MonthSeriesPoint[]>(
    () =>
      points.map((p) => ({
        t: ymToMidTs(p.yearMonth),
        yearMonth: p.yearMonth,
        priceEok: toEok(seriesAvgMan(p, dealType)),
        volume: seriesVolume(p, dealType),
      })),
    [points, dealType],
  );

  const domain = useMemo<[number, number]>(() => {
    if (!points.length) return [0, 1];
    const start = ymToStartTs(points[0]!.yearMonth);
    const end = ymToEndTs(points[points.length - 1]!.yearMonth);
    return [start, end];
  }, [points]);

  const { scatterDeals, extremePoints } = useMemo(() => {
    const mapped: DealScatterPoint[] = [];
    for (const deal of deals) {
      const t = dealDateToTs(deal.dealDate);
      const priceEok = toEok(deal.dealAmount);
      if (t == null || priceEok == null) continue;
      if (t < domain[0] || t > domain[1]) continue;
      mapped.push({
        t,
        priceEok,
        dealDate: deal.dealDate,
        dealAmount: deal.dealAmount,
        exclusiveArea: deal.exclusiveArea,
        floor: deal.floor,
        kind: "deal",
        id: deal.id,
      });
    }

    if (!mapped.length) {
      return { scatterDeals: mapped, extremePoints: [] as DealScatterPoint[] };
    }

    let high = mapped[0]!;
    let low = mapped[0]!;
    for (const row of mapped) {
      if (row.dealAmount > high.dealAmount) high = row;
      if (row.dealAmount < low.dealAmount) low = row;
    }
    const extremes: DealScatterPoint[] = [
      { ...high, kind: "high" },
    ];
    if (low.id !== high.id) {
      extremes.push({ ...low, kind: "low" });
    }
    const extremeIds = new Set(extremes.map((row) => row.id));
    return {
      scatterDeals: mapped.filter((row) => !extremeIds.has(row.id)),
      extremePoints: extremes,
    };
  }, [deals, domain]);

  const extremeKey = useMemo(
    () => extremePoints.map((row) => `${row.kind}:${row.id}`).join("|"),
    [extremePoints],
  );
  const priorityExtreme =
    priorityState.key === extremeKey ? priorityState.value : null;

  useLayoutEffect(() => {
    extremeKeyRef.current = extremeKey;
    extremeHitsRef.current = [];
  }, [extremeKey]);

  const extremeDotShape = useCallback(
    (props: { cx?: number; cy?: number; payload?: DealScatterPoint }) => (
      <ExtremeDot {...props} registerExtremeHit={registerExtremeHit} />
    ),
    [registerExtremeHit],
  );

  const dealDotShape = useCallback(
    (props: { cx?: number; cy?: number; payload?: DealScatterPoint }) => (
      <ExtremeDot {...props} />
    ),
    [],
  );

  const tooltipContent = useMemo(
    () => <PriceChartTooltip priorityExtreme={priorityExtreme} />,
    [priorityExtreme],
  );

  const priceLabel = seriesLabel(dealType);
  const priceLineColor = seriesLineColor(dealType);
  const showPriceLine = dealType !== "monthly";
  const hasVolume = monthSeries.some((row) => row.volume > 0);

  const legendItems = [
    showPriceLine
      ? { name: priceLabel, color: priceLineColor, swatch: "line" as const }
      : null,
    { name: "실거래", color: CHART_COLORS.deal, swatch: "dot" as const },
  ].filter(Boolean) as Array<{
    name: string;
    color: string;
    swatch: "line" | "dot" | "bar";
  }>;

  const handleChartClick = useCallback(
    (state: {
      chartX?: number;
      activeLabel?: number | string;
      activePayload?: Array<{
        payload?: (MonthSeriesPoint | DealScatterPoint) & {
          yearMonth?: string;
          dealDate?: string;
          kind?: string;
        };
      }>;
    } | null) => {
      if (!onMonthSelect || !state) return;
      let ym: string | null = null;
      const monthPayload = state.activePayload?.find(
        (item) =>
          item.payload &&
          typeof item.payload.yearMonth === "string" &&
          item.payload.kind == null,
      )?.payload?.yearMonth;
      if (monthPayload) {
        ym = monthPayload;
      } else {
        const dealDate = state.activePayload?.find(
          (item) => item.payload && typeof item.payload.dealDate === "string",
        )?.payload?.dealDate;
        if (dealDate && dealDate.length >= 7) {
          ym = `${dealDate.slice(0, 4)}${dealDate.slice(5, 7)}`;
        }
      }
      if (!ym && typeof state.activeLabel === "number" && monthSeries.length) {
        let best: string | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const row of monthSeries) {
          const dist = Math.abs(row.t - state.activeLabel);
          if (dist < bestDist) {
            bestDist = dist;
            best = row.yearMonth;
          }
        }
        ym = best;
      }
      if (!ym) return;
      // 거래 없는 달(선만 이어진 달)을 누르면 가장 가까운, 거래 있는 달로 — 빈 목록을 만들지 않는다
      const hit = monthSeries.find((row) => row.yearMonth === ym);
      if (!hit || hit.volume <= 0) {
        const at = hit?.t ?? (typeof state.activeLabel === "number" ? state.activeLabel : null);
        if (at == null) return;
        let best: string | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const row of monthSeries) {
          if (row.volume <= 0) continue;
          const dist = Math.abs(row.t - at);
          if (dist < bestDist) {
            bestDist = dist;
            best = row.yearMonth;
          }
        }
        if (!best) return;
        ym = best;
      }
      onMonthSelect(ym === selectedMonthYm ? null : ym);
    },
    [onMonthSelect, monthSeries, selectedMonthYm],
  );

  if (monthSeries.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500">
        선택한 기간의 시세 데이터가 없습니다.
      </div>
    );
  }

  const xTicks = monthSeries
    .filter((row) => row.yearMonth.endsWith("01"))
    .map((row) => row.t);

  const countReady = dealCount != null && !!dealCountLabel;
  /** Remount series on period/type change so draw animation always replays. */
  const chartAnimKey = `${domain[0]}-${domain[1]}-${dealType}-${monthSeries.length}`;

  return (
    <div className="w-full">
      <div className="detail-price-chart-legend" aria-label="차트 범례">
        <ul className="detail-price-chart-legend-items">
          {legendItems.map((item) => (
            <li key={item.name} className="detail-price-chart-legend-item">
              <span
                className={
                  item.swatch === "line"
                    ? "detail-price-chart-legend-line"
                    : "detail-price-chart-legend-swatch"
                }
                style={{ backgroundColor: item.color }}
                aria-hidden
              />
              <span className="text-[color:var(--lab-navy-700)]">{item.name}</span>
            </li>
          ))}
        </ul>
        {countReady ? (
          <p className="detail-price-chart-legend-count">
            <span className="detail-price-chart-legend-count-label">
              {dealCountLabel}
            </span>{" "}
            <span className="detail-price-chart-legend-count-value">
              {Number(dealCount).toLocaleString("ko-KR")}건
            </span>
          </p>
        ) : null}
      </div>

      <div className="detail-price-chart-stack">
        <div className="detail-price-chart-plot">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              key={`plot-${chartAnimKey}`}
              margin={{ ...PRICE_CHART_MARGIN }}
              onMouseMove={handleChartMouseMove}
              onMouseLeave={clearPriorityExtreme}
              onClick={handleChartClick}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#e2e8f0"
                vertical={false}
              />
              <XAxis
                type="number"
                dataKey="t"
                domain={domain}
                allowDataOverflow
                ticks={xTicks.length ? xTicks : undefined}
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  return `${String(d.getUTCFullYear()).slice(2)}년`;
                }}
                tick={{ fill: "#64748b", fontSize: 12, dy: 4 }}
                axisLine={{ stroke: "#e2e8f0" }}
                tickLine={false}
                height={24}
              />
              <YAxis
                type="number"
                dataKey="priceEok"
                tickFormatter={(v: number) => `${v}억`}
                tick={{ fill: "#64748b", fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={PRICE_Y_AXIS_WIDTH}
                domain={["auto", "auto"]}
              />
              <Tooltip
                content={tooltipContent}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 40, outline: "none", pointerEvents: "none" }}
                offset={8}
                cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
                position={
                  priorityExtreme
                    ? { x: priorityExtreme.x + 10, y: priorityExtreme.y - 12 }
                    : undefined
                }
              />
              {showPriceLine ? (
                <Line
                  data={monthSeries}
                  type="monotone"
                  dataKey="priceEok"
                  name={priceLabel}
                  stroke={priceLineColor}
                  strokeWidth={2.4}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0, fill: priceLineColor }}
                  connectNulls
                  isAnimationActive
                  animationDuration={CHART_ANIMATION_MS}
                  animationEasing="ease-out"
                />
              ) : null}
              <Scatter
                data={scatterDeals}
                dataKey="priceEok"
                name="실거래"
                fill={CHART_COLORS.deal}
                isAnimationActive
                animationDuration={CHART_ANIMATION_MS}
                animationEasing="ease-out"
                shape={dealDotShape}
              />
              <Scatter
                data={extremePoints}
                dataKey="priceEok"
                name="최고최저"
                isAnimationActive
                animationDuration={CHART_ANIMATION_MS}
                animationEasing="ease-out"
                shape={extremeDotShape}
                legendType="none"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {hasVolume ? (
          <div className="detail-price-chart-volume" aria-label="월별 거래량">
            <span className="pointer-events-none absolute left-0 top-0.5 z-[1] w-[34px] pr-0.5 text-right text-[12px] font-medium leading-none text-[color:var(--lab-muted)]">
              거래량
            </span>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                key={`vol-${chartAnimKey}`}
                data={monthSeries}
                margin={{ ...VOLUME_CHART_MARGIN }}
                onClick={handleChartClick}
              >
                <XAxis
                  type="number"
                  dataKey="t"
                  domain={domain}
                  allowDataOverflow
                  hide
                />
                <YAxis
                  type="number"
                  dataKey="volume"
                  hide
                  width={0}
                  domain={[0, "auto"]}
                />
                <Tooltip
                  content={<VolumeTooltip />}
                  allowEscapeViewBox={{ x: false, y: true }}
                  cursor={{ fill: "rgba(148, 163, 184, 0.12)" }}
                  wrapperStyle={{ zIndex: 40, outline: "none", pointerEvents: "none" }}
                  offset={8}
                />
                <Bar
                  dataKey="volume"
                  name="거래량"
                  fill={CHART_COLORS.volume}
                  fillOpacity={0.9}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive
                  animationDuration={CHART_ANIMATION_MS}
                  animationEasing="ease-out"
                  maxBarSize={10}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type DragHandle = "start" | "end";

export function PeriodRangeSlider({
  months,
  startIndex,
  endIndex,
  onChange,
  onRecentYears,
  onFullRange,
  activePreset = null,
  showPresets = true,
}: {
  months: string[];
  startIndex: number;
  endIndex: number;
  onChange: (start: number, end: number) => void;
  onRecentYears?: (years: number) => void;
  onFullRange?: () => void;
  activePreset?: "recent1" | "recent3" | "recent5" | "full" | null;
  /** When false, presets are expected in the parent section header. */
  showPresets?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef({ startIndex, endIndex });

  if (months.length === 0) return null;

  const startYm = months[startIndex] ?? months[0];
  const endYm = months[endIndex] ?? months[months.length - 1];
  const max = months.length - 1;
  const startPct = max <= 0 ? 0 : (startIndex / max) * 100;
  const endPct = max <= 0 ? 100 : (endIndex / max) * 100;

  const indexFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || max <= 0) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * max);
  };

  const applyDrag = (clientX: number, handle: DragHandle) => {
    const next = indexFromClientX(clientX);
    const { startIndex: s, endIndex: e } = valuesRef.current;
    if (handle === "start") {
      const start = Math.min(next, e);
      valuesRef.current = { startIndex: start, endIndex: e };
      onChange(start, e);
    } else {
      const end = Math.max(next, s);
      valuesRef.current = { startIndex: s, endIndex: end };
      onChange(s, end);
    }
  };

  const pickHandle = (clientX: number): DragHandle => {
    const idx = indexFromClientX(clientX);
    const { startIndex: s, endIndex: e } = valuesRef.current;
    return Math.abs(idx - s) <= Math.abs(idx - e) ? "start" : "end";
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    handle?: DragHandle,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    valuesRef.current = { startIndex, endIndex };
    const selected = handle ?? pickHandle(event.clientX);
    applyDrag(event.clientX, selected);

    const onMove = (ev: PointerEvent) => applyDrag(ev.clientX, selected);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const presetBtn = (active: boolean) => labSecondaryTabClass(active);

  const rangeLabel = (
    <>
      {formatYmLabel(startYm)}
      <span className="mx-1 text-slate-400">~</span>
      {formatYmLabel(endYm)}
    </>
  );

  return (
    <div className={showPresets ? "mt-2 space-y-1" : "mt-1 space-y-0.5"}>
      {showPresets ? (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[13px] leading-5">
          <p className="font-medium tabular-nums text-slate-700">{rangeLabel}</p>
          <div className="flex w-fit flex-wrap items-center gap-1">
            {onRecentYears
              ? ([1, 3, 5] as const).map((years) => {
                  const key =
                    years === 1 ? "recent1" : years === 3 ? "recent3" : "recent5";
                  const pressed = activePreset === key;
                  return (
                    <button
                      key={years}
                      type="button"
                      onClick={() => onRecentYears(years)}
                      aria-pressed={pressed}
                      className={presetBtn(pressed)}
                    >
                      {years}년
                    </button>
                  );
                })
              : null}
            {onFullRange ? (
              <button
                type="button"
                onClick={onFullRange}
                aria-pressed={activePreset === "full"}
                className={presetBtn(activePreset === "full")}
              >
                전체
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="relative flex min-h-11 touch-none select-none items-center">
        <div
          ref={trackRef}
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 cursor-pointer rounded-full bg-[color:var(--lab-border)]"
          onPointerDown={(e) => beginDrag(e)}
        >
          <div
            className="absolute top-0 h-full rounded-full bg-[color:var(--lab-brand-primary)]"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(endPct - startPct, 0)}%`,
            }}
          />
        </div>

        <button
          type="button"
          role="slider"
          aria-label="시작 기간"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={startIndex}
          className="absolute top-1/2 z-30 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center active:cursor-grabbing"
          style={{ left: `${startPct}%` }}
          onPointerDown={(e) => beginDrag(e, "start")}
        >
          <span
            aria-hidden
            className="pointer-events-none block h-4 w-4 rounded-full border-2 border-[color:var(--lab-brand-hover)] bg-white shadow-sm"
          />
        </button>
        <button
          type="button"
          role="slider"
          aria-label="종료 기간"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={endIndex}
          className="absolute top-1/2 z-30 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center active:cursor-grabbing"
          style={{ left: `${endPct}%` }}
          onPointerDown={(e) => beginDrag(e, "end")}
        >
          <span
            aria-hidden
            className="pointer-events-none block h-4 w-4 rounded-full border-2 border-[color:var(--lab-brand-hover)] bg-white shadow-sm"
          />
        </button>
      </div>

      <div className="detail-caption flex items-center justify-between gap-2 leading-none">
        <span className="min-w-0 shrink tabular-nums">
          {formatYmLabel(months[0])}
        </span>
        {!showPresets ? (
          <span className="min-w-0 truncate text-center font-medium tabular-nums text-slate-600">
            {rangeLabel}
          </span>
        ) : (
          <span />
        )}
        <span className="min-w-0 shrink text-right tabular-nums">
          {formatYmLabel(months[months.length - 1])}
        </span>
      </div>
    </div>
  );
}
