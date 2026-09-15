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
  regionSlug?: string;
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

function formatAreaShort(m: CompareComplexMetrics): string {
  if (!m.matchedArea) return "—";
  const min = m.matchedArea.exclusiveMin;
  const max = m.matchedArea.exclusiveMax;
  // Header: one representative ㎡ (avoid range that stretches the row).
  return `${((min + max) / 2).toFixed(2)}㎡`;
}

/** Household count only — show — when unknown. */
function formatHousehold(m: CompareComplexMetrics): string {
  if (m.householdCount == null || m.householdCount <= 0) return "—";
  return m.householdCount.toLocaleString("ko-KR");
}

function formatBuildYear(m: CompareComplexMetrics): string {
  return m.buildYear != null ? String(m.buildYear) : "—";
}

function areaBandLabel(center: number | null): string {
  if (center == null || !Number.isFinite(center)) return "최근 거래 기준";
  return `전용 ${Math.round(center)}㎡대 · 최근 거래 기준`;
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
        className="ml-1 inline-flex cursor-pointer list-none items-center justify-center text-[12px] leading-none text-slate-400 transition hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 [&::-webkit-details-marker]:hidden"
        aria-label="주변 단지 비교 안내"
      >
        <span aria-hidden="true">ⓘ</span>
      </summary>
      <div className="absolute left-0 top-[calc(100%+0.35rem)] z-20 w-72 max-w-[calc(100vw-2.5rem)] space-y-1 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-pretty text-[12px] leading-5 text-slate-600 shadow-sm">
        <p>
          같은 동·인근 지역에서 전용면적, 준공연도, 최근 거래와 확인 가능한 단지
          규모를 기준으로 비교 단지를 자동 선정합니다.
        </p>
        <p>거리 기반 추천은 아닙니다.</p>
      </div>
    </details>
  );
}

/** Compact metric×complex matrix — mobile & desktop; no horizontal scroll. */
function CompareMatrix({ columns }: { columns: CompareComplexMetrics[] }) {
  const n = columns.length;
  const gridStyle = {
    gridTemplateColumns: `minmax(2.35rem,0.5fr) repeat(${n}, minmax(0,1fr))`,
  } as const;

  const rows: Array<{
    label: string;
    values: string[];
    strong?: boolean;
    muted?: boolean;
    large?: boolean;
  }> = [
    {
      label: "매매",
      values: columns.map((c) => formatMan(c.latestSaleMan)),
      strong: true,
      large: true,
    },
    {
      label: "전세",
      values: columns.map((c) => formatMan(c.latestJeonseMan)),
      large: true,
    },
    {
      label: "㎡당",
      values: columns.map((c) => formatPerSqm(c.salePerSqmMan)),
      muted: true,
    },
    {
      label: "세대수",
      values: columns.map(formatHousehold),
      muted: true,
    },
    {
      label: "준공",
      values: columns.map(formatBuildYear),
      muted: true,
    },
  ];

  return (
    <div className="mt-2">
      <div
        className="grid items-end gap-x-1 border-b border-slate-200/80 pb-2 pt-1.5"
        style={gridStyle}
      >
        <span className="text-[10px] text-slate-400" aria-hidden="true" />
        {columns.map((c, i) => {
          const isCurrent = i === 0;
          // Current complex name: teal. Peers: black (link).
          const nameClass = `line-clamp-2 text-[12px] font-semibold leading-snug sm:text-[13px] ${
            isCurrent ? "text-teal-700" : "text-slate-900"
          }`;
          return (
            <div
              key={`h-${c.aptName}`}
              className="min-w-0 px-0.5 text-center sm:px-1"
            >
              {isCurrent ? (
                <span className={nameClass}>{c.aptName}</span>
              ) : (
                <Link
                  href={aptDetailHref(c.aptName, c.regionSlug, c.gu)}
                  className={`block hover:text-teal-700 ${nameClass}`}
                >
                  {c.aptName}
                </Link>
              )}
              <p className="mt-0.5 mb-1 text-[11px] tabular-nums leading-none text-slate-500">
                {formatAreaShort(c)}
              </p>
            </div>
          );
        })}
      </div>

      {rows.map((row) => (
        <div
          key={row.label}
          className="grid items-center gap-x-1 border-b border-slate-100 py-1.5 last:border-0"
          style={gridStyle}
        >
          <p
            className={`leading-none text-slate-500 ${
              row.large
                ? "text-[14px] font-medium sm:text-[15px]"
                : "text-[11px] sm:text-[12px]"
            }`}
          >
            {row.label}
          </p>
          {row.values.map((v, i) => (
            <p
              key={`${row.label}-${i}`}
              className={`min-w-0 truncate px-0.5 text-center tabular-nums leading-snug ${
                row.large
                  ? "text-[13px] sm:text-[14px]"
                  : "text-[12px] sm:text-[13px]"
              } ${
                row.strong
                  ? "font-semibold text-slate-900"
                  : row.muted
                    ? "font-medium text-slate-600"
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

/** Auto 주변 단지 비교 — compact matrix; up to 2 peers; no search. */
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
          peers[i]?.householdCount ?? null,
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
    <LabCard className="p-3.5 sm:p-5">
      <div className="lab-section-heading !mb-0 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center">
            주변 단지 비교
            <CompareInfoTip />
          </h2>
        </div>
        <p className="shrink-0 pt-0.5 text-right text-[11px] leading-4 text-slate-500 sm:text-[12px]">
          {areaBandLabel(areaCenter)}
        </p>
      </div>

      {loadingPeers ? (
        <p className="mt-2 text-[12px] text-slate-500">
          비교 단지를 불러오는 중…
        </p>
      ) : null}

      {empty ? (
        <p className="mt-2 text-[12px] leading-snug text-slate-500">
          비교할 수 있는 주변 유사 단지가 아직 없습니다.
        </p>
      ) : null}

      {!loadingPeers && !empty ? <CompareMatrix columns={columns} /> : null}
    </LabCard>
  );
}
