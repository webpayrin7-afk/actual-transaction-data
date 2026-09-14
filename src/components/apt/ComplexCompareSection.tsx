"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import type {
  AptAreaOption,
  AptDetailResponse,
  AptSuggestion,
} from "@/lib/molit/apt-client";
import {
  buildCompareInsights,
  buildCompareMetrics,
  compareAreaRefFromOption,
  type CompareComplexMetrics,
} from "@/lib/complex-detail/compare-metrics";
import { formatEok } from "@/lib/utils/format";
import { areaSelectorClosedLabel } from "@/lib/apt/area-selector-label";

type Props = {
  aptName: string;
  regionSlug: string;
  gu?: string;
  detail: AptDetailResponse;
  selectedArea: AptAreaOption | null;
  areaKey: string;
};

type PeerSlot = {
  aptName: string;
  regionSlug: string;
  gu: string;
};

function formatMan(man: number | null): string {
  if (man == null || !Number.isFinite(man) || man <= 0) return "—";
  return formatEok(man);
}

function MetricRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_repeat(3,minmax(0,1fr))] gap-1 border-b border-slate-100 py-2 last:border-0 sm:gap-2">
      <p className="text-[11px] text-slate-500 sm:text-xs">{label}</p>
      {values.map((v, i) => (
        <p
          key={`${label}-${i}`}
          className="text-right text-[12px] font-medium tabular-nums text-slate-900 sm:text-sm"
        >
          {v}
        </p>
      ))}
    </div>
  );
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

async function searchPeers(q: string): Promise<AptSuggestion[]> {
  if (q.trim().length < 1) return [];
  const res = await fetch(`/api/apt-suggest?q=${encodeURIComponent(q.trim())}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { suggestions?: AptSuggestion[] };
  return json.suggestions ?? [];
}

function emptyColumn(): CompareComplexMetrics {
  return {
    aptName: "—",
    regionSlug: "",
    gu: "",
    dong: "",
    buildYear: null,
    matchedArea: null,
    matchNote: null,
    latestSaleMan: null,
    latestSaleDate: null,
    latestJeonseMan: null,
    latestJeonseDate: null,
    jeonseRatioPct: null,
    saleCount12m: 0,
    periodHighSaleMan: null,
    vsPeriodHighPct: null,
  };
}

/** Inline 단지 비교 — current fixed; up to 2 peers via apt-suggest. */
export function ComplexCompareSection({
  aptName,
  detail,
  selectedArea,
  areaKey,
}: Props) {

  const [query, setQuery] = useState("");
  const [peers, setPeers] = useState<PeerSlot[]>([]);
  const [hits, setHits] = useState<AptSuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  const areaLabel =
    areaKey === "all" || !selectedArea
      ? "전체 면적"
      : areaSelectorClosedLabel(selectedArea);

  const targetArea = useMemo(
    () => compareAreaRefFromOption(selectedArea, areaLabel),
    [selectedArea, areaLabel],
  );

  const baseMetrics = useMemo(
    () => buildCompareMetrics(detail, targetArea),
    [detail, targetArea],
  );

  const peer0 = useQuery({
    queryKey: ["compare-peer", peers[0]?.aptName, peers[0]?.regionSlug],
    queryFn: () =>
      fetchDetail(peers[0]!.aptName, peers[0]!.regionSlug, peers[0]!.gu),
    enabled: !!peers[0],
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });
  const peer1 = useQuery({
    queryKey: ["compare-peer", peers[1]?.aptName, peers[1]?.regionSlug],
    queryFn: () =>
      fetchDetail(peers[1]!.aptName, peers[1]!.regionSlug, peers[1]!.gu),
    enabled: !!peers[1],
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const peerMetrics = useMemo(() => {
    const out: CompareComplexMetrics[] = [];
    for (const d of [peer0.data, peer1.data]) {
      if (d) out.push(buildCompareMetrics(d, targetArea));
    }
    return out;
  }, [peer0.data, peer1.data, targetArea]);

  const columns = [baseMetrics, ...peerMetrics];
  while (columns.length < 3) columns.push(emptyColumn());

  const insights = buildCompareInsights(baseMetrics, peerMetrics);

  async function onSearch() {
    setSearching(true);
    try {
      const list = await searchPeers(query);
      setHits(
        list.filter(
          (s) =>
            s.aptName !== aptName &&
            !peers.some((p) => p.aptName === s.aptName),
        ),
      );
    } finally {
      setSearching(false);
    }
  }

  function addPeer(s: AptSuggestion) {
    if (peers.length >= 2) return;
    setPeers((prev) => [
      ...prev,
      { aptName: s.aptName, regionSlug: s.regionSlug, gu: s.gu },
    ]);
    setHits([]);
    setQuery("");
  }

  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading
        title="단지 비교"
        description={`${areaLabel} 기준 · 최대 2개 단지`}
      />

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          className="lab-input h-10 min-w-0 flex-1 px-3 text-sm"
          placeholder="비교할 단지 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSearch();
          }}
          disabled={peers.length >= 2}
        />
        <button
          type="button"
          className="lab-button lab-button-secondary h-10 shrink-0 px-4 text-sm"
          onClick={() => void onSearch()}
          disabled={peers.length >= 2 || searching || query.trim().length < 1}
        >
          {searching ? "검색 중…" : "검색"}
        </button>
      </div>

      {hits.length > 0 ? (
        <ul className="mt-2 max-h-40 overflow-auto rounded-xl border border-slate-100">
          {hits.slice(0, 8).map((s) => (
            <li key={`${s.regionSlug}-${s.aptName}`}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => addPeer(s)}
              >
                <span className="truncate font-medium text-slate-900">
                  {s.aptName}
                </span>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {s.gu} {s.dong}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {peers.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {peers.map((p) => (
            <button
              key={p.aptName}
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-700"
              onClick={() =>
                setPeers((prev) => prev.filter((x) => x.aptName !== p.aptName))
              }
            >
              {p.aptName}
              <span className="text-slate-400">×</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-slate-400">
          비교할 단지를 검색해 추가하세요. (최대 2개)
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[320px]">
          <div className="grid grid-cols-[minmax(0,0.9fr)_repeat(3,minmax(0,1fr))] gap-1 border-b border-slate-200 pb-2 sm:gap-2">
            <p className="text-[11px] text-slate-400">항목</p>
            {columns.map((c, i) => (
              <p
                key={`h-${i}`}
                className="truncate text-right text-[12px] font-semibold text-slate-900 sm:text-sm"
              >
                {i === 0 ? aptName : c.aptName}
              </p>
            ))}
          </div>

          <MetricRow
            label="비교 면적"
            values={columns.map((c) =>
              c.matchedArea
                ? c.matchedArea.label
                : c.matchNote === "비교 가능한 유사 면적 없음"
                  ? "유사 면적 없음"
                  : "—",
            )}
          />
          <MetricRow
            label="최근 매매"
            values={columns.map((c) => formatMan(c.latestSaleMan))}
          />
          <MetricRow
            label="최근 전세"
            values={columns.map((c) => formatMan(c.latestJeonseMan))}
          />
          <MetricRow
            label="전세가율"
            values={columns.map((c) =>
              c.jeonseRatioPct != null ? `${c.jeonseRatioPct}%` : "—",
            )}
          />
          <MetricRow
            label="12개월 매매"
            values={columns.map((c) =>
              c.aptName === "—" ? "—" : `${c.saleCount12m}건`,
            )}
          />
          <MetricRow
            label="기간 최고 대비"
            values={columns.map((c) =>
              c.vsPeriodHighPct != null
                ? `${c.vsPeriodHighPct > 0 ? "+" : ""}${c.vsPeriodHighPct}%`
                : "—",
            )}
          />
          <MetricRow
            label="준공"
            values={columns.map((c) =>
              c.buildYear != null ? `${c.buildYear}` : "—",
            )}
          />
        </div>
      </div>

      {insights.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {insights.map((text) => (
            <li key={text} className="text-[12px] leading-relaxed text-slate-600">
              · {text}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-[11px] text-slate-400">
        면적은 전용㎡ 유사 구간으로 맞춥니다. 관리비는 세대당 단순 환산만 동일
        의미일 때 비교합니다(면적 관리비 아님).
      </p>
    </LabCard>
  );
}
