"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabTabs, labTabId, labTabPanelId } from "@/components/ui/LabTabs";
import {
  RANKING_TABS,
  fetchRegionRankingBoards,
  formatRankingAsOf,
  rankingComplexHref,
  regionRankingCode,
  rowPublicMetrics,
  unavailableBoardCopy,
  type RankingType,
  type RegionRankingRow,
} from "@/lib/region-ranking/public";

const PREVIEW_COUNT = 5;

function RankMark({ rank }: { rank: number }) {
  const top = rank >= 1 && rank <= 3;
  return (
    <span
      className={`w-7 shrink-0 text-right text-lg font-semibold tabular-nums sm:w-8 ${
        top ? "text-slate-900" : "text-slate-500"
      }`}
    >
      {rank}
    </span>
  );
}

function RowMetrics({
  type,
  row,
}: {
  type: RankingType;
  row: RegionRankingRow;
}) {
  const metrics = rowPublicMetrics(type, row);
  if (type === "COMPOSITE") {
    return metrics.hint ? (
      <p className="text-[13px] leading-5 text-slate-500">
        {metrics.hint}
      </p>
    ) : null;
  }
  return (
    <div className="min-w-0 text-right">
      {metrics.primary ? (
        <p className="text-[15px] font-semibold leading-6 tabular-nums text-slate-900">
          {metrics.primary}
        </p>
      ) : null}
      {metrics.secondary ? (
        <p className="text-[13px] leading-5 text-slate-500">{metrics.secondary}</p>
      ) : null}
    </div>
  );
}

export function RegionLeaderboard({
  regionSlug,
  regionName,
  lawdCodes,
}: {
  regionSlug: string;
  regionName: string;
  lawdCodes: string[];
}) {
  const regionCode = regionRankingCode(lawdCodes);
  const [tab, setTab] = useState<RankingType>("COMPOSITE");
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["region-ranking-boards", regionCode],
    queryFn: () => fetchRegionRankingBoards(regionCode!),
    enabled: !!regionCode,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const board = query.data?.[tab] ?? null;
  const rows = board?.status === "ok" ? board.rows : [];
  const visible = expanded ? rows.slice(0, 10) : rows.slice(0, PREVIEW_COUNT);
  const asOf = useMemo(() => {
    const dates = RANKING_TABS.map((item) => query.data?.[item.id]?.transactionAsOf)
      .filter(Boolean);
    return formatRankingAsOf(board?.transactionAsOf ?? dates[0] ?? null);
  }, [board?.transactionAsOf, query.data]);
  const activeTab = RANKING_TABS.find((item) => item.id === tab);

  if (!regionCode) return null;

  return (
    <section
      id="region-ranking"
      className="lab-card scroll-mt-28 p-4 md:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold leading-[26px] text-slate-900 lg:text-xl lg:leading-7">
          이 지역 아파트 랭킹
        </h2>
        {asOf ? (
          <p className="text-[13px] leading-5 text-slate-500">{asOf}</p>
        ) : null}
      </div>

      <LabTabs
        items={RANKING_TABS}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setExpanded(false);
        }}
        ariaLabel="지역 아파트 랭킹"
        variant="secondary"
        className="mt-4"
        idPrefix="region-ranking-view"
      />

      <div role="tabpanel" id={labTabPanelId("region-ranking-view", tab)} aria-labelledby={labTabId("region-ranking-view", tab)}>
      {tab === "COMPOSITE" ? (
        <div className="mt-3 flex items-center text-[13px] font-medium text-slate-600">
          <span>집랩 종합랭킹</span>
          <InfoTip aria-label="집랩 종합랭킹 안내">
            <p>{activeTab?.hint}</p>
          </InfoTip>
        </div>
      ) : activeTab?.hint ? (
        <div className="mt-3 flex items-center text-[13px] text-slate-500">
          <span>{tab === "TRADE_VOLUME" ? "최근 3개월 매매" : "최근 3개월 중위값"}</span>
          <InfoTip aria-label={`${activeTab.label} 기준 안내`}>
            <p>{activeTab.hint}</p>
          </InfoTip>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="mt-4 space-y-2" aria-label="순위 불러오는 중">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-center">
          <p className="text-sm font-medium text-slate-700">
            순위를 불러오지 못했습니다.
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="lab-button lab-button-secondary mt-3 min-h-10 px-4 text-sm"
          >
            다시 시도
          </button>
        </div>
      ) : board?.status !== "ok" ? (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-5 text-center">
          <p className="text-sm font-medium text-slate-800">
            {unavailableBoardCopy(tab).title}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">
            {unavailableBoardCopy(tab).helper}
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-5 text-center">
          <p className="text-sm font-medium text-slate-800">
            이 지역에 표시할 순위가 없습니다.
          </p>
        </div>
      ) : (
      <ol className="mt-3 divide-y divide-slate-200">
          {visible.map((row) => {
            const href = rankingComplexHref({
              aptName: row.apt_name,
              regionSlug,
              gu: regionName,
            });
            const name = row.apt_name?.trim() || "단지명 없음";
            const metrics = (
              <RowMetrics type={tab} row={row} />
            );
            const body = (
              <>
                <RankMark rank={row.rank} />
                <div className="min-w-0 flex-1">
                  <p className="break-keep text-base font-semibold leading-6 text-slate-900">
                    {name}
                  </p>
                  {row.dong ? (
                    <p className="mt-0.5 text-[13px] leading-5 text-slate-500">
                      {row.dong}
                    </p>
                  ) : null}
                  {tab === "COMPOSITE" ? (
                    <div className="mt-0.5">{metrics}</div>
                  ) : null}
                </div>
                {tab !== "COMPOSITE" ? (
                  <div className="max-w-[46%] shrink-0">{metrics}</div>
                ) : null}
              </>
            );
            return (
              <li key={`${row.complex_id}-${row.rank}`}>
                {href ? (
                  <Link
                    href={href}
                    data-event="ranking_complex_click"
                    data-complex-id={row.complex_id}
                    className="flex items-center gap-3 py-2.5 min-h-11"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 py-2.5">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {board?.status === "ok" && rows.length > PREVIEW_COUNT && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="lab-button lab-button-secondary mt-3 w-full min-h-11 text-sm"
        >
          전체 순위 보기
        </button>
      ) : null}
      </div>
    </section>
  );
}
