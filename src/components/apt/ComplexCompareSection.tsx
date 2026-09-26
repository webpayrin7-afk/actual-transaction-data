"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { LabSection } from "@/components/ui/LabSection";
import type {
  AptAreaOption,
  AptDetailResponse,
} from "@/lib/molit/apt-client";
import { APT_API_VERSION, aptDetailHref } from "@/lib/molit/apt-client";
import { unpackAptDetail } from "@/lib/molit/apt-detail-wire";
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

/**
 * 단지 페이지(AptDetailPage)와 같은 요청·같은 React Query 키로 받는다 — 서버는 months 와 무관하게
 * 전체 이력을 120개월로 묶어 주므로 데이터는 같고, 비교 단지를 눌러 들어가거나 그 단지 페이지를
 * 먼저 봤을 때 CDN·브라우저·RQ 캐시를 함께 쓴다. URL 파라미터 순서도 단지 페이지와 같게 둔다.
 * 단지 페이지 queryFn 과 캐시를 나누므로 실패는 null 이 아니라 throw 로 둔다.
 */
const PEER_DETAIL_MONTHS = 120;

function peerDetailQueryKey(aptName?: string, region?: string, gu?: string) {
  return ["apt-detail", aptName, region, gu?.trim() ?? "", "full", PEER_DETAIL_MONTHS];
}

async function fetchDetail(
  aptName: string,
  region: string,
  gu?: string,
): Promise<AptDetailResponse> {
  const qs = new URLSearchParams({
    aptName,
    region,
    months: String(PEER_DETAIL_MONTHS),
  });
  if (gu?.trim()) qs.set("gu", gu.trim());
  qs.set("v", APT_API_VERSION);
  const res = await fetch(`/api/apt-detail?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return unpackAptDetail(await res.json());
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

/**
 * Metric×complex matrix — label 72px sticky, complex cols min 104px,
 * horizontal scroll when needed; selected column subtle bg.
 */
function CompareMatrix({ columns }: { columns: CompareComplexMetrics[] }) {
  const n = columns.length;
  const gridStyle = {
    gridTemplateColumns: `72px repeat(${n}, minmax(104px, 1fr))`,
  } as const;

  const rows: Array<{
    label: string;
    values: string[];
    price?: boolean;
  }> = [
    {
      label: "매매",
      values: columns.map((c) => formatMan(c.latestSaleMan)),
      price: true,
    },
    {
      label: "전세",
      values: columns.map((c) => formatMan(c.latestJeonseMan)),
      price: true,
    },
    {
      label: "㎡당",
      values: columns.map((c) => formatPerSqm(c.salePerSqmMan)),
    },
    {
      label: "세대수",
      values: columns.map(formatHousehold),
    },
    {
      label: "준공",
      values: columns.map(formatBuildYear),
    },
  ];

  return (
    <div>
      <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <div className="min-w-0" style={{ minWidth: 72 + n * 104 }}>
          <div
            className="grid items-end gap-x-0 border-b border-[color:var(--lab-border)] pb-2 pt-1.5"
            style={gridStyle}
          >
            <span
              className="sticky left-0 z-10 bg-[color:var(--lab-surface)]"
              aria-hidden="true"
            />
            {columns.map((c, i) => {
              const isCurrent = i === 0;
              return (
                <div
                  key={`h-${c.aptName}`}
                  className="min-w-0 px-3 text-center"
                >
                  {isCurrent ? (
                    <span className="detail-label line-clamp-2 font-semibold !text-[color:var(--lab-brand-primary)]">
                      {c.aptName}
                    </span>
                  ) : (
                    <Link
                      href={aptDetailHref(c.aptName, c.regionSlug, c.gu)}
                      className="detail-label block line-clamp-2 font-semibold text-[color:var(--lab-navy-950)] hover:text-[color:var(--lab-teal-700)]"
                    >
                      {c.aptName}
                    </Link>
                  )}
                  <p className="detail-meta mt-0.5 mb-1 tabular-nums">
                    {formatAreaShort(c)}
                  </p>
                </div>
              );
            })}
          </div>

          {rows.map((row) => (
            <div
              key={row.label}
              className="grid min-h-11 items-center gap-x-0 border-b border-slate-100 last:border-0"
              style={gridStyle}
            >
              <p className="detail-label sticky left-0 z-10 bg-[color:var(--lab-surface)] px-0 py-2.5 pr-2">
                {row.label}
              </p>
              {row.values.map((v, i) => (
                <p
                  key={`${row.label}-${i}`}
                  className={`min-w-0 truncate px-3 py-2.5 text-center tabular-nums ${
                    row.price
                      ? "detail-data-value-emphasis"
                      : "detail-label text-[color:var(--lab-navy-950)]"
                  }`}
                >
                  {v}
                </p>
              ))}
            </div>
          ))}
        </div>
      </div>
      {n > 2 ? (
        <p className="detail-meta">좌우로 밀어서 다른 단지를 확인하세요.</p>
      ) : null}
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
    queryKey: peerDetailQueryKey(
      peers[0]?.aptName,
      peers[0]?.regionSlug,
      peers[0]?.gu,
    ),
    queryFn: () =>
      fetchDetail(peers[0]!.aptName, peers[0]!.regionSlug, peers[0]!.gu),
    enabled: !!peers[0],
    staleTime: 30 * 60 * 1000, // 단지 페이지와 같게
    retry: 0,
  });
  const peer1 = useQuery({
    queryKey: peerDetailQueryKey(
      peers[1]?.aptName,
      peers[1]?.regionSlug,
      peers[1]?.gu,
    ),
    queryFn: () =>
      fetchDetail(peers[1]!.aptName, peers[1]!.regionSlug, peers[1]!.gu),
    enabled: !!peers[1],
    staleTime: 30 * 60 * 1000, // 단지 페이지와 같게
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
    <LabSection
      id="section-comparison"
      title="주변 단지 비교"
      meta={areaBandLabel(areaCenter)}
      tip={
        <>
          <p>
            같은 동·인근 지역에서 면적·연식·규모가 비슷한 단지를 자동으로
            골라 비교합니다.
          </p>
          <p>거리 기반 추천은 아닙니다.</p>
        </>
      }
    >

      {loadingPeers ? (
        <p className="detail-meta">비교 단지를 불러오는 중…</p>
      ) : null}

      {empty ? (
        <p className="detail-meta">
          비교할 수 있는 주변 유사 단지가 아직 없습니다.
        </p>
      ) : null}

      {!loadingPeers && !empty ? <CompareMatrix columns={columns} /> : null}
    </LabSection>
  );
}
