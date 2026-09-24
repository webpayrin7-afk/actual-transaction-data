"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApplyhomeResult, ResultOutcome, ResultsQuery } from "@/lib/applyhome/read";
import { Pagination } from "@/components/Pagination";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LabTag } from "@/components/ui/LabTag";
import { shortMan } from "@/components/presale/ApplyhomeSections";

type ResultsResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: ApplyhomeResult[];
  counts: Record<ResultOutcome, number>;
};

const OUTCOME: Record<ResultOutcome, { label: string; tone?: "brand" | "up" | "down" }> = {
  local1: { label: "1순위 해당지역 마감", tone: "brand" },
  rank1: { label: "1순위 마감", tone: "brand" },
  rank2: { label: "2순위 마감" },
  short: { label: "청약 미달", tone: "down" },
  none: { label: "접수 기록 없음" },
};

export const AREA_OPTIONS = [
  { id: "all", label: "전체" },
  { id: "s", label: "60㎡ 미만" },
  { id: "m", label: "60~85㎡" },
  { id: "l", label: "85㎡ 초과" },
] as const;

export const PRICE_OPTIONS = [
  { id: "all", label: "전체" },
  { id: "p1", label: "5억 미만" },
  { id: "p2", label: "5~9억" },
  { id: "p3", label: "9~15억" },
  { id: "p4", label: "15억 이상" },
] as const;

async function fetchResults(q: ResultsQuery): Promise<ResultsResponse> {
  const qs = new URLSearchParams({
    metro: q.metro,
    supplier: q.supplier,
    area: q.area,
    price: q.price,
    page: String(q.page),
  });
  const res = await fetch(`/api/applyhome/results?${qs}`);
  if (!res.ok) throw new Error("분양 결과를 불러오지 못했습니다.");
  return res.json();
}

const ym2 = (iso: string | null) => (iso ? `${iso.slice(2, 4)}.${iso.slice(5, 7)}` : "");

/** 분양 결과 — 최근 12개월 주택형별 청약 결과 (면적·분양가 필터, 15건씩). */
export function PresaleResults({
  metro,
  supplier,
  area,
  price,
  toolbar,
}: Pick<ResultsQuery, "metro" | "supplier" | "area" | "price"> & { toolbar?: React.ReactNode }) {
  const [pageState, setPageState] = useState({ key: "", page: 1 });
  const filterKey = `${metro}|${supplier}|${area}|${price}`;
  const page = pageState.key === filterKey ? pageState.page : 1;
  const topRef = useRef<HTMLParagraphElement>(null);

  const query = useQuery({
    queryKey: ["applyhome-results", filterKey, page],
    queryFn: () => fetchResults({ metro, supplier, area, price, page }),
    staleTime: 30 * 60_000,
    placeholderData: (prev) => prev,
  });
  const data = query.data;
  const c = data?.counts;
  const closed = c ? c.local1 + c.rank1 + c.rank2 : 0;

  return (
    <LabSection
      title="분양 결과"
      meta={data ? `최근 12개월 ${data.total.toLocaleString("ko-KR")}개 주택형` : undefined}
      tip={
        <p>
          최근 12개월 안에 접수가 끝난 분양 공고를 주택형별로 보여줍니다. 마감 판정은 접수 건수가 일반공급 세대
          이상인지로 매겼습니다 — 1순위 해당지역만으로 채우면 &lsquo;1순위 해당지역 마감&rsquo;, 기타지역까지 합쳐
          채우면 &lsquo;1순위 마감&rsquo;, 2순위까지 합쳐 채우면 &lsquo;2순위 마감&rsquo;, 모자라면 &lsquo;청약
          미달&rsquo;입니다. 예비 입주자 비율은 반영하지 않았습니다. 분양가는 주택형 최고가입니다.
        </p>
      }
    >
      {toolbar}
      {c && data && data.total > 0 ? (
        <p ref={topRef} className="detail-meta scroll-mt-28 tabular-nums">
          마감 {closed.toLocaleString("ko-KR")} · 미달 {c.short.toLocaleString("ko-KR")}
          {c.none ? ` · 기록 없음 ${c.none.toLocaleString("ko-KR")}` : ""}
        </p>
      ) : null}

      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : query.isError ? (
        <p className="detail-body">{(query.error as Error).message}</p>
      ) : !data || data.items.length === 0 ? (
        <p className="detail-body">조건에 맞는 분양 결과가 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {data.items.map((r) => {
              const o = OUTCOME[r.outcome];
              return (
                <LabListRow
                  key={`${r.noticeId}-${r.modelNo}`}
                  href={`/presale/${r.noticeId}`}
                  wrap
                  title={
                    <>
                      {r.name}
                      <span className="ml-1 font-normal text-[color:var(--lab-muted)]">/ {r.typeLabel}</span>
                    </>
                  }
                  meta={
                    <>
                      <span className="block tabular-nums">
                        {[
                          r.place,
                          r.exclusiveArea ? `전용 ${Math.round(r.exclusiveArea)}㎡` : null,
                          r.isPublic ? "공공" : null,
                          r.rceptEnd ? `${ym2(r.rceptEnd)} 마감` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                        <LabTag tone={o.tone}>{o.label}</LabTag>
                        {r.rate != null ? <span>1순위 {r.rate}:1</span> : null}
                      </span>
                    </>
                  }
                  value={r.topAmount ? shortMan(r.topAmount) : "—"}
                  sub={r.supply ? `일반 ${r.supply}세대` : null}
                />
              );
            })}
          </ul>
          {data.total > data.pageSize ? (
            <Pagination
              page={data.page}
              totalPages={Math.ceil(data.total / data.pageSize)}
              totalCount={data.total}
              onPageChange={(p) => {
                setPageState({ key: filterKey, page: p });
                topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}
