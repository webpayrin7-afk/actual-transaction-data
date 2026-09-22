"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";
import {
  REGION_APT_RANK_TIP,
  REGION_APT_RANK_TIP_TITLE,
  REGION_APT_RANK_TITLE,
  REGION_RANK_CURRENT_COMPLEX_LABEL,
  REGION_RANK_EMPTY_DECADE_COPY,
  REGION_RANK_UNAVAILABLE_COPY,
  REGION_RANK_V3_TABS,
  fetchRegionRankingBoard,
  formatReferenceMonthCompact,
  rankingComplexHref,
  rankingRowMetaLine,
  regionRankingCode,
  type RegionRankingRow,
} from "@/lib/region-ranking/public";
import { labSecondaryTabClass, labSegmentedClass } from "@/components/ui/lab";

const PREVIEW_COUNT = 10;

function RankMark({ rank }: { rank: number }) {
  const top = rank >= 1 && rank <= 3;
  return (
    <span
      className={`w-7 shrink-0 text-right text-[15px] font-semibold tabular-nums sm:w-8 sm:text-base ${
        top ? "text-slate-900" : "text-slate-500"
      }`}
    >
      {rank}
    </span>
  );
}

function ScopeToggle({
  guLabel,
  dongLabel,
  scope,
  onChange,
}: {
  guLabel: string;
  dongLabel: string;
  scope: "gu" | "dong";
  onChange: (next: "gu" | "dong") => void;
}) {
  return (
    <div
      className={`${labSegmentedClass("mt-3")} w-full max-w-full`}
      role="tablist"
      aria-label="순위 지역 범위"
    >
      {(
        [
          { id: "gu" as const, label: guLabel },
          { id: "dong" as const, label: dongLabel },
        ] as const
      ).map((item) => {
        const active = scope === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={labSecondaryTabClass(active, "min-h-9 flex-1 px-2.5 text-[13px]")}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function RegionLeaderboard({
  regionSlug,
  regionName,
  lawdCodes,
  dongName = null,
  dongRegionCode = null,
  fromComplexId = null,
}: {
  regionSlug: string;
  regionName: string;
  lawdCodes: string[];
  dongName?: string | null;
  dongRegionCode?: string | null;
  fromComplexId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const guCode = regionRankingCode(lawdCodes);
  const dongCode =
    dongRegionCode && /^[0-9]{10}$/.test(dongRegionCode) ? dongRegionCode : null;
  const canDong = Boolean(dongCode && dongName?.trim());
  const scopeParam = searchParams.get("scope");
  const effectiveScope: "gu" | "dong" =
    canDong && (scopeParam === "dong" || (!scopeParam && Boolean(dongCode)))
      ? "dong"
      : "gu";
  const regionCode =
    effectiveScope === "dong" && dongCode ? dongCode : guCode;

  const [tab, setTab] = useState("COMPOSITE");
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["region-ranking-v3", regionCode, tab],
    queryFn: () =>
      fetchRegionRankingBoard({
        regionCode: regionCode!,
        rankingType: tab,
        limit: 20,
      }),
    enabled: !!regionCode,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const board = query.data ?? null;
  const rows = board?.status === "ok" ? board.rows : [];
  const visible = expanded ? rows.slice(0, 20) : rows.slice(0, PREVIEW_COUNT);
  const asOf = useMemo(
    () => formatReferenceMonthCompact(board?.transactionAsOf ?? null),
    [board?.transactionAsOf],
  );
  const sourceComplex = fromComplexId?.trim() || null;
  const isDecade = tab !== "COMPOSITE";

  const setScope = (next: "gu" | "dong") => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "stats");
    params.set("section", "ranking");
    if (next === "dong" && dongName) {
      params.set("dong", dongName);
      if (dongCode) params.set("regionCode", dongCode);
      params.set("scope", "dong");
    } else {
      params.set("scope", "gu");
      params.delete("regionCode");
      if (dongName) params.set("dong", dongName);
    }
    if (sourceComplex) params.set("fromComplexId", sourceComplex);
    router.replace(`${pathname}?${params.toString()}#region-ranking`, {
      scroll: false,
    });
  };

  if (!guCode) return null;

  return (
    <section
      id="region-ranking"
      className="lab-card scroll-mt-28 px-3.5 py-4 sm:px-5 sm:py-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center">
          <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
            {REGION_APT_RANK_TITLE}
          </h2>
          <InfoTip aria-label="지역 아파트 순위 안내">
            <p className="font-medium text-slate-800">{REGION_APT_RANK_TIP_TITLE}</p>
            <p className="mt-1.5">{REGION_APT_RANK_TIP}</p>
          </InfoTip>
        </div>
        {asOf ? (
          <p className="text-[12px] leading-4 text-slate-500">{asOf}</p>
        ) : null}
      </div>

      {canDong ? (
        <ScopeToggle
          guLabel={regionName}
          dongLabel={dongName!.trim()}
          scope={effectiveScope}
          onChange={setScope}
        />
      ) : null}

      <div
        className={`${labSegmentedClass("mt-3 !flex-nowrap !overflow-x-auto")} w-full max-w-full`}
        role="tablist"
        aria-label="지역 아파트 순위 평형대"
      >
        {REGION_RANK_V3_TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-event="ranking_tab_change"
              data-ranking-type={item.id}
              onClick={() => {
                setTab(item.id);
                setExpanded(false);
              }}
              className={labSecondaryTabClass(
                active,
                "min-h-9 shrink-0 px-2.5 text-[13px] sm:px-3",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <div className="mt-4 space-y-2" aria-label="순위 불러오는 중">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-100" />
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
            {REGION_RANK_UNAVAILABLE_COPY}
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-5 text-center">
          <p className="text-sm font-medium text-slate-800">
            {isDecade ? REGION_RANK_EMPTY_DECADE_COPY : REGION_RANK_UNAVAILABLE_COPY}
          </p>
        </div>
      ) : (
        <ol className="mt-3 divide-y divide-slate-100">
          {visible.map((row) => (
            <RankingRow
              key={`${row.complex_id}-${row.rank}`}
              row={row}
              regionSlug={regionSlug}
              gu={regionName}
              currentComplexId={sourceComplex}
            />
          ))}
        </ol>
      )}

      {board?.status === "ok" && rows.length > PREVIEW_COUNT && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="lab-button lab-button-secondary mt-3 w-full min-h-10 text-sm"
        >
          더보기
        </button>
      ) : null}
    </section>
  );
}

function RankingRow({
  row,
  regionSlug,
  gu,
  currentComplexId,
}: {
  row: RegionRankingRow;
  regionSlug: string;
  gu: string;
  currentComplexId: string | null;
}) {
  const href = rankingComplexHref({
    aptName: row.apt_name,
    regionSlug,
    gu,
    complexId: row.complex_id,
  });
  const name = row.apt_name?.trim() || "단지명 없음";
  const meta = rankingRowMetaLine(row);
  const isCurrent =
    currentComplexId != null && currentComplexId === row.complex_id;
  const body = (
    <>
      <RankMark rank={row.rank} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-5 text-slate-900">
          {name}
          {isCurrent ? (
            <span className="ml-1.5 text-[11px] font-medium text-slate-500">
              {REGION_RANK_CURRENT_COMPLEX_LABEL}
            </span>
          ) : null}
        </p>
        {meta ? (
          <p className="mt-0.5 truncate text-[12px] leading-4 text-slate-500">
            {meta}
          </p>
        ) : null}
      </div>
    </>
  );
  return (
    <li>
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
}
