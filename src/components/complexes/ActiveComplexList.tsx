"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import type { ActiveComplexesResponse } from "@/lib/complexes/active-complexes";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

async function fetchActive(): Promise<ActiveComplexesResponse> {
  const res = await fetch("/api/complexes/active");
  if (!res.ok) throw new Error("거래 활발 단지를 불러오지 못했습니다.");
  return res.json();
}

export function ActiveComplexList() {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["complexes-active"],
    queryFn: fetchActive,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;
  useLoadProgressWhen(query.isLoading && !data, "단지 목록 불러오는 중…");
  const items = data?.items ?? [];
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      title="최근 30일 거래 많은 단지"
      tip={data?.note ? <p>{data.note}</p> : undefined}
    >
      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : query.isError ? (
        <p className="detail-body">{(query.error as Error).message}</p>
      ) : !items.length ? (
        <p className="detail-body">최근 30일 동안 거래가 많은 단지가 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((item) => (
              <LabListRow
                key={`${item.aptNameNorm}|${item.lawdCd}|${item.dong}`}
                href={item.href}
                title={
                  <>
                    <span className="mr-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-[color:var(--lab-border)] px-1 align-[1px] text-[12px] font-semibold leading-4 tabular-nums text-[color:var(--lab-muted)]">
                      {item.rank}
                    </span>
                    {item.aptName}
                  </>
                }
                meta={item.regionLabel}
                value={`${item.recentCount.toLocaleString("ko-KR")}건`}
                sub={item.latestDealDate ? `최근 ${item.latestDealDate.slice(5, 10).replace("-", ".")}` : undefined}
              />
            ))}
          </ul>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}
