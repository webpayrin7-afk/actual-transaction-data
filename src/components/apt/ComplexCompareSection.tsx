"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { LabCard } from "@/components/ui/lab";
import type {
  AptAreaOption,
  AptDetailResponse,
} from "@/lib/molit/apt-client";
import { aptDetailHref } from "@/lib/molit/apt-client";
import {
  buildCompareMetrics,
  compareAreaRefFromOption,
  withHouseholdCount,
  type CompareComplexMetrics,
} from "@/lib/complex-detail/compare-metrics";
import type { ComparePeerCandidate } from "@/lib/complex-detail/select-compare-peers";
import { formatEok } from "@/lib/utils/format";
import { areaSelectorClosedLabel } from "@/lib/apt/area-selector-label";

type Props = {
  aptName: string;
  regionSlug: string;
  gu?: string;
  dong?: string;
  detail: AptDetailResponse;
  selectedArea: AptAreaOption | null;
  areaKey: string;
  householdCount?: number | null;
};

function formatMan(man: number | null): string {
  if (man == null || !Number.isFinite(man) || man <= 0) return "—";
  return formatEok(man);
}

function formatPerSqm(man: number | null): string {
  if (man == null || !Number.isFinite(man) || man <= 0) return "—";
  if (man >= 10000) {
    const eok = man / 10000;
    return `${eok.toFixed(eok >= 10 ? 1 : 2)}억`;
  }
  return `${Math.round(man).toLocaleString("ko-KR")}만`;
}

function formatArea(m: CompareComplexMetrics): string {
  if (!m.matchedArea) return "—";
  const min = m.matchedArea.exclusiveMin;
  const max = m.matchedArea.exclusiveMax;
  if (Math.abs(max - min) < 0.05) return `${min.toFixed(2)}㎡`;
  return `${min.toFixed(2)}~${max.toFixed(2)}㎡`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[1].slice(2)}.${m[2]}.${m[3]}`;
}

async function fetchDetail(
  aptName: string,
  region: string,
  gu?: string,
): Promise<AptDetailResponse | null> {
  const qs = new URLSearchParams({ aptName, region, months: "36" });
  if (gu?.trim()) qs.set("gu", gu.trim());
  const res = await fetch(`/api/apt-detail?${qs}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchPeers(params: {
  aptName: string;
  gu: string;
  dong: string;
  areaCenter: number | null;
  buildYear: number | null;
  householdCount: number | null;
}): Promise<ComparePeerCandidate[]> {
  const qs = new URLSearchParams({
    aptName: params.aptName,
    gu: params.gu,
  });
  if (params.dong) qs.set("dong", params.dong);
  if (params.areaCenter != null) qs.set("areaCenter", String(params.areaCenter));
  if (params.buildYear != null) qs.set("buildYear", String(params.buildYear));
  if (params.householdCount != null) {
    qs.set("householdCount", String(params.householdCount));
  }
  const res = await fetch(`/api/complex-compare-peers?${qs}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { peers?: ComparePeerCandidate[] };
  return json.peers ?? [];
}

function CompareInfoTip() {
  return (
    <details className="relative inline-flex shrink-0 align-middle">
      <summary
        className="ml-1.5 inline-flex cursor-pointer list-none items-center justify-center text-[13px] leading-none text-slate-400 transition hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 [&::-webkit-details-marker]:hidden"
        aria-label="주변 단지 비교 안내"
      >
        <span aria-hidden="true">ⓘ</span>
      </summary>
      <div className="absolute left-0 top-[calc(100%+0.35rem)] z-20 w-72 max-w-[calc(100vw-2.5rem)] space-y-1 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-pretty text-[12px] leading-5 text-slate-600 shadow-sm">
        <p>
          같은 동·인근 지역에서 면적, 준공연도, 단지 규모가 유사하고 최근 거래가
          있는 단지를 자동으로 선정합니다.
        </p>
        <p>거리 기반 추천은 아닙니다.</p>
      </div>
    </details>
  );
}

function MetricLines({ m }: { m: CompareComplexMetrics }) {
  return (
    <dl className="mt-1.5 space-y-1 text-[12px] leading-snug">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-500">매매</dt>
        <dd className="text-right">
          <span className="font-semibold tabular-nums text-slate-900">
            {formatMan(m.latestSaleMan)}
          </span>
          {m.latestSaleDate ? (
            <span className="ml-1.5 text-[10px] tabular-nums text-slate-400">
              {formatDate(m.latestSaleDate)}
            </span>
          ) : null}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-500">전세</dt>
        <dd className="text-right">
          <span className="font-medium tabular-nums text-slate-800">
            {formatMan(m.latestJeonseMan)}
          </span>
          {m.latestJeonseDate ? (
            <span className="ml-1.5 text-[10px] text-slate-400">
              {formatDate(m.latestJeonseDate)}
            </span>
          ) : null}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-500">㎡당</dt>
        <dd className="font-medium tabular-nums text-slate-800">
          {formatPerSqm(m.salePerSqmMan)}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-500">준공</dt>
        <dd className="tabular-nums text-slate-700">
          {m.buildYear != null ? m.buildYear : "—"}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate-500">세대</dt>
        <dd className="tabular-nums text-slate-700">
          {m.householdCount != null
            ? m.householdCount.toLocaleString("ko-KR")
            : "—"}
        </dd>
      </div>
    </dl>
  );
}

function MobileCard({
  m,
  role,
  href,
}: {
  m: CompareComplexMetrics;
  role: "current" | "peer";
  href?: string;
}) {
  return (
    <div className="py-2.5">
      <p className="text-[10px] font-medium text-slate-400">
        {role === "current" ? "현재 단지" : "비교 단지"}
      </p>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        {href ? (
          <Link
            href={href}
            className="min-w-0 truncate text-[13px] font-semibold text-teal-700 hover:text-teal-800"
          >
            {m.aptName}
          </Link>
        ) : (
          <p className="truncate text-[13px] font-semibold text-slate-900">
            {m.aptName}
          </p>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
          {formatArea(m)}
        </span>
      </div>
      <MetricLines m={m} />
    </div>
  );
}

function DesktopTable({ columns }: { columns: CompareComplexMetrics[] }) {
  const colCount = columns.length;
  const gridStyle = {
    gridTemplateColumns: `minmax(4.5rem,0.7fr) repeat(${colCount}, minmax(0,1fr))`,
  } as const;

  const rows: Array<{ label: string; values: string[]; strong?: boolean }> = [
    { label: "전용면적", values: columns.map(formatArea) },
    {
      label: "최근 매매",
      values: columns.map((c) => formatMan(c.latestSaleMan)),
      strong: true,
    },
    {
      label: "최근 전세",
      values: columns.map((c) => formatMan(c.latestJeonseMan)),
    },
    {
      label: "㎡당",
      values: columns.map((c) => formatPerSqm(c.salePerSqmMan)),
    },
    {
      label: "준공",
      values: columns.map((c) =>
        c.buildYear != null ? String(c.buildYear) : "—",
      ),
    },
    {
      label: "세대수",
      values: columns.map((c) =>
        c.householdCount != null
          ? c.householdCount.toLocaleString("ko-KR")
          : "—",
      ),
    },
  ];

  return (
    <div className="hidden md:block">
      <div className="grid gap-2 border-b border-slate-200 pb-2" style={gridStyle}>
        <p className="text-[11px] text-slate-400">항목</p>
        {columns.map((c, i) =>
          i === 0 ? (
            <div key={`h-${c.aptName}`} className="min-w-0 text-right">
              <p className="text-[10px] font-medium text-slate-400">현재 단지</p>
              <p className="truncate text-[12px] font-semibold text-slate-900 sm:text-sm">
                {c.aptName}
              </p>
            </div>
          ) : (
            <div key={`h-${c.aptName}`} className="min-w-0 text-right">
              <p className="text-[10px] font-medium text-slate-400">비교 단지</p>
              <Link
                href={aptDetailHref(c.aptName, c.regionSlug, c.gu)}
                className="block truncate text-[12px] font-semibold text-teal-700 hover:text-teal-800 sm:text-sm"
              >
                {c.aptName}
              </Link>
            </div>
          ),
        )}
      </div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid gap-2 border-b border-slate-100 py-2 last:border-0"
          style={gridStyle}
        >
          <p className="text-[11px] text-slate-500">{row.label}</p>
          {row.values.map((v, i) => (
            <p
              key={`${row.label}-${i}`}
              className={`text-right text-[12px] tabular-nums sm:text-sm ${
                row.strong
                  ? "font-semibold text-slate-900"
                  : "font-medium text-slate-800"
              }`}
            >
              {v}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Auto 주변 단지 비교 — no search; up to 2 peers. */
export function ComplexCompareSection({
  aptName,
  gu,
  dong,
  detail,
  selectedArea,
  areaKey,
  householdCount = null,
}: Props) {
  const areaLabel =
    areaKey === "all" || !selectedArea
      ? "전체 면적"
      : areaSelectorClosedLabel(selectedArea);

  const targetArea = useMemo(
    () => compareAreaRefFromOption(selectedArea, areaLabel),
    [selectedArea, areaLabel],
  );

  const areaCenter = targetArea
    ? (targetArea.exclusiveMin + targetArea.exclusiveMax) / 2
    : null;

  const resolvedGu = (gu?.trim() || detail.gu || "").trim();
  const resolvedDong = (dong?.trim() || detail.dong || "").trim();

  const peersQuery = useQuery({
    queryKey: [
      "complex-compare-peers",
      aptName,
      resolvedGu,
      resolvedDong,
      areaCenter,
      detail.buildYear,
      householdCount,
    ],
    queryFn: () =>
      fetchPeers({
        aptName,
        gu: resolvedGu,
        dong: resolvedDong,
        areaCenter,
        buildYear: detail.buildYear,
        householdCount: householdCount ?? null,
      }),
    enabled: resolvedGu.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const peers = peersQuery.data ?? [];

  const peer0 = useQuery({
    queryKey: ["compare-peer-detail", peers[0]?.aptName, peers[0]?.regionSlug],
    queryFn: () =>
      fetchDetail(peers[0]!.aptName, peers[0]!.regionSlug, peers[0]!.gu),
    enabled: !!peers[0],
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const peer1 = useQuery({
    queryKey: ["compare-peer-detail", peers[1]?.aptName, peers[1]?.regionSlug],
    queryFn: () =>
      fetchDetail(peers[1]!.aptName, peers[1]!.regionSlug, peers[1]!.gu),
    enabled: !!peers[1],
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const baseMetrics = useMemo(
    () =>
      withHouseholdCount(
        buildCompareMetrics(detail, targetArea),
        householdCount,
      ),
    [detail, targetArea, householdCount],
  );

  const peerMetrics = useMemo(() => {
    const out: CompareComplexMetrics[] = [];
    const details = [peer0.data, peer1.data];
    details.forEach((d, i) => {
      if (!d) return;
      out.push(
        withHouseholdCount(
          buildCompareMetrics(d, targetArea),
          peers[i]?.householdCount,
        ),
      );
    });
    return out;
  }, [peer0.data, peer1.data, peers, targetArea]);

  const columns = [baseMetrics, ...peerMetrics];
  const loadingPeers =
    peersQuery.isLoading ||
    (peers.length > 0 &&
      ((!!peers[0] && peer0.isLoading) || (!!peers[1] && peer1.isLoading)));
  const empty = !peersQuery.isLoading && !loadingPeers && peers.length === 0;

  return (
    <LabCard className="p-4 sm:p-5">
      <div className="min-w-0">
        <h2 className="flex items-center text-[1.25rem] font-semibold tracking-tight text-[color:var(--lab-navy-950,#0f172a)]">
          주변 단지 비교
          <CompareInfoTip />
        </h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          같은 동·인근 지역의 유사 단지 기준
        </p>
      </div>

      {loadingPeers ? (
        <p className="mt-3 text-[12px] text-slate-500">
          비교 단지를 불러오는 중…
        </p>
      ) : null}

      {empty ? (
        <p className="mt-3 text-[12px] leading-snug text-slate-500">
          비교할 수 있는 주변 유사 단지가 아직 없습니다.
        </p>
      ) : null}

      {!loadingPeers && !empty ? (
        <>
          <div className="mt-2 divide-y divide-slate-100 md:hidden">
            <MobileCard m={baseMetrics} role="current" />
            {peerMetrics.map((m) => (
              <MobileCard
                key={m.aptName}
                m={m}
                role="peer"
                href={aptDetailHref(m.aptName, m.regionSlug, m.gu)}
              />
            ))}
          </div>
          <div className="mt-3">
            <DesktopTable columns={columns} />
          </div>
        </>
      ) : null}

      <p className="mt-3 text-[11px] text-slate-400">
        {areaLabel} 기준 · 전용㎡가 가까운 유형을 맞춰 비교합니다.
      </p>
    </LabCard>
  );
}
