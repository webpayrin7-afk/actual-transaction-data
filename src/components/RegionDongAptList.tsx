"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aptDetailHref } from "@/lib/molit/apt-client";
import type { RegionBrowseResponse } from "@/lib/molit/service";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import { BackLink } from "@/components/layout/BackLink";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabTag } from "@/components/ui/LabTag";

async function fetchRegionDongApts(params: {
  region: string;
  dong: string;
  gu?: string;
}): Promise<RegionBrowseResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    dong: params.dong,
  });
  if (params.gu && params.gu !== "all") qs.set("gu", params.gu);
  const res = await fetch(`/api/region-browse?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

const REGION_BROWSE_STALE_TIME_MS = 10 * 60 * 1000;

export function RegionDongAptList({
  regionSlug,
  regionName,
  dong,
  gu,
}: {
  regionSlug: string;
  regionName: string;
  dong: string;
  gu?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["region-browse-apts", regionSlug, dong, gu ?? ""],
    queryFn: () =>
      fetchRegionDongApts({
        region: regionSlug,
        dong,
        gu,
      }),
    staleTime: REGION_BROWSE_STALE_TIME_MS,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  useLoadProgressWhen(query.isLoading && !data, "단지 목록 불러오는 중…");
  const apts = data?.apts ?? [];
  const visible = expanded ? apts : apts.slice(0, LAB_LIST_PREVIEW);
  const totalDeals = apts.reduce((sum, a) => sum + a.dealCount, 0);

  return (
    <div className={PAGE_SHELL}>
      <header className="-mt-1 sm:-mt-1.5">
        <PageHeader
          leading={<BackLink fallback={`/region/${regionSlug}?tab=dong`} compact hideLabel />}
          title={dong}
          titleSuffix={gu && gu !== "all" ? `${regionName} ${gu}` : regionName}
          titleClassName="detail-page-title"
          showDivider={false}
        >
          {apts.length ? (
            <div className="flex flex-wrap gap-1" aria-label="동 요약">
              <LabTag size="md">{`${apts.length.toLocaleString("ko-KR")}개 단지`}</LabTag>
              <LabTag size="md">{`누적 매매 ${totalDeals.toLocaleString("ko-KR")}건`}</LabTag>
            </div>
          ) : null}
        </PageHeader>
      </header>

      <section aria-label={`${dong} 단지 목록`} className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}>
        <LabSectionHeader
          title="단지 목록"
          meta="거래량 많은 순"
          tip={<p>이 동에서 매매 실거래 이력이 있는 단지입니다. 단지를 누르면 상세로 이동합니다.</p>}
        />
        {query.isError ? (
          <p className="detail-body">단지 목록을 불러오지 못했습니다.</p>
        ) : query.isLoading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: LAB_LIST_PREVIEW }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
        ) : apts.length === 0 ? (
          <p className="detail-body">이 동에서 찾은 단지가 없습니다.</p>
        ) : (
          <>
            <ul className={LAB_LIST}>
              {visible.map((apt) => (
                <LabListRow
                  key={`${apt.gu}-${apt.aptName}`}
                  href={aptDetailHref(apt.aptName, regionSlug, apt.gu)}
                  title={apt.aptName}
                  meta={[
                    apt.buildYear ? `${apt.buildYear}년 준공` : null,
                    apt.latestDealDate ? `최근 ${formatDealDate(apt.latestDealDate)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  value={`${apt.dealCount.toLocaleString("ko-KR")}건`}
                  sub={apt.maxDealAmount > 0 ? `최고 ${formatEok(apt.maxDealAmount)}` : undefined}
                />
              ))}
            </ul>
            {apts.length > LAB_LIST_PREVIEW ? (
              <LabMoreButton
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
                label={`${apts.length - LAB_LIST_PREVIEW}곳 더보기`}
              />
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
