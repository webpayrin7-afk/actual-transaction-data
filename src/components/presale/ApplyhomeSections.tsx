"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApplyhomeCompetition, ApplyhomeNotice, ApplyhomeOverview } from "@/lib/applyhome/read";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

export async function fetchApplyhome(): Promise<ApplyhomeOverview> {
  const res = await fetch("/api/applyhome");
  if (!res.ok) throw new Error("청약 정보를 불러오지 못했습니다.");
  return res.json();
}

export function useApplyhome() {
  return useQuery({ queryKey: ["applyhome"], queryFn: fetchApplyhome, staleTime: 30 * 60_000 });
}

/** "all" = 전국 */
export type PresaleMetro = string;
/** 공급 주체 — 공공 = 국민주택(LH 등) */
export type PresaleSupplier = "all" | "private" | "public";
export type PresaleFilter = { metro: PresaleMetro; supplier: PresaleSupplier };

export const md = (iso: string | null) => (iso ? iso.slice(5, 10).replace("-", ".") : "");
export const ymDot = (v: string | null) => (v && v.length === 6 ? `${v.slice(0, 4)}.${v.slice(4)}` : "");

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** 억 한 자리: 50466 → "5", 216300 → "21.6" */
const eok1 = (man: number) => String(Math.round(man / 1000) / 10);

/** 금액 짧게: 216300 → "21.6억", 9800 → "9,800만" */
export function shortMan(v: number): string {
  return v >= 10_000 ? `${eok1(v)}억` : `${v.toLocaleString("ko-KR")}만`;
}

/** 분양가 범위 짧게: "5~7.2억", 1억 미만이 섞이면 "9,800만~1.2억" */
export function priceRange(lo: number | null, hi: number | null): string | null {
  if (lo == null) return null;
  if (hi == null || hi === lo) return shortMan(lo);
  return lo >= 10_000 ? `${eok1(lo)}~${eok1(hi)}억` : `${shortMan(lo)}~${shortMan(hi)}`;
}

/** 오른쪽 상태: 접수 중 / D-n */
function status(n: ApplyhomeNotice, today: string): { text: string; live: boolean } {
  const start = n.specialBegin ?? n.rceptBegin;
  if (start && start <= today) return { text: "접수 중", live: true };
  if (start) return { text: `D-${daysBetween(today, start)}`, live: false };
  return { text: "", live: false };
}

/** 민영은 기본이라 생략하고 국민(공공)·신혼희망타운 등만 붙인다 */
export function kindLabel(kind: string | null): string | null {
  return kind?.replace(/(^| · )민영$/, "").replace(/ · 국민$/, "").replace(/^국민$/, "공공") || null;
}

function metaOf(n: ApplyhomeNotice): string {
  return [n.place, n.totalSupply ? `${n.totalSupply.toLocaleString("ko-KR")}세대` : null, kindLabel(n.kind)]
    .filter(Boolean)
    .join(" · ");
}

const matches = ({ metro, supplier }: PresaleFilter) => (n: ApplyhomeNotice) => {
  if (metro !== "all" && n.metro !== metro) return false;
  if (supplier === "all") return true;
  const isPublic = /국민/.test(n.kind ?? "");
  return supplier === "public" ? isPublic : !isPublic;
};
const detailHref = (n: ApplyhomeNotice) => `/presale/${n.id}`;

function MoreList<T>({
  items,
  step,
  render,
  unit = "곳",
}: {
  items: T[];
  /** 한 번에 더 여는 수. 없으면 한 번에 전부 */
  step?: number;
  render: (item: T) => React.ReactNode;
  unit?: string;
}) {
  const [shown, setShown] = useState(LAB_LIST_PREVIEW);
  const visible = items.slice(0, shown);
  const rest = items.length - shown;
  return (
    <>
      <ul className={LAB_LIST}>{visible.map(render)}</ul>
      {items.length > LAB_LIST_PREVIEW ? (
        <LabMoreButton
          expanded={rest <= 0}
          onToggle={() => setShown(rest <= 0 ? LAB_LIST_PREVIEW : step ? shown + step : items.length)}
          label={`${step ? Math.min(step, rest) : rest}${unit} 더보기`}
        />
      ) : null}
    </>
  );
}

/** 접수가 끝나지 않은 청약 (특별공급 시작일 순). */
export function ApplyhomeUpcomingSection({ filter }: { filter: PresaleFilter }) {
  const query = useApplyhome();
  const data = query.data;
  if (query.isError) return null;
  const items = (data?.upcoming ?? []).filter(matches(filter));
  const listKey = `${filter.metro}|${filter.supplier}`;

  return (
    <LabSection
      title="청약 일정"
      meta={data ? `${items.length}곳` : undefined}
      tip={
        <p>
          한국부동산원 청약홈에 올라온 분양 공고 중 접수가 끝나지 않은 곳입니다. 금액은 주택형별 최고 분양가의
          범위입니다.
        </p>
      }
    >
      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : items.length === 0 ? (
        <p className="detail-body">지금 접수 중이거나 예정된 청약이 없습니다.</p>
      ) : (
        <MoreList
          key={listKey}
          items={items}
          render={(n) => {
            const st = status(n, data!.today);
            return (
              <LabListRow
                key={n.id}
                href={detailHref(n)}
                wrap
                title={n.name}
                meta={
                  <>
                    <span className="block">{metaOf(n)}</span>
                    <span className="block tabular-nums">
                      {n.specialBegin && n.specialBegin !== n.rceptBegin ? `특별 ${md(n.specialBegin)} · ` : ""}
                      1순위 {md(n.rceptBegin)}
                      {n.rceptEnd && n.rceptEnd !== n.rceptBegin ? `~${md(n.rceptEnd)}` : ""}
                      {n.winnerDate ? ` · 발표 ${md(n.winnerDate)}` : ""}
                    </span>
                  </>
                }
                value={<span style={st.live ? { color: "var(--lab-brand-primary)" } : undefined}>{st.text}</span>}
                sub={priceRange(n.priceMin, n.priceMax)}
              />
            );
          }}
        />
      )}
    </LabSection>
  );
}

function RateRow({ n }: { n: ApplyhomeCompetition }) {
  return (
    <LabListRow
      key={n.id}
      href={detailHref(n)}
      wrap
      title={n.name}
      meta={
        <>
          <span className="block">{metaOf(n)}</span>
          <span className="block tabular-nums">
            {n.firstRankRequests > 0
              ? `일반 ${n.generalSupply.toLocaleString("ko-KR")}세대에 ${n.firstRankRequests.toLocaleString("ko-KR")}명`
              : "1순위 접수 기록 없음"}
            {n.rceptEnd ? ` · ${md(n.rceptEnd)} 마감` : ""}
          </span>
        </>
      }
      value={n.rate > 0 ? `${n.rate.toLocaleString("ko-KR")}:1` : "—"}
      sub={priceRange(n.priceMin, n.priceMax)}
    />
  );
}

/** 최근 30일 접수가 끝난 청약의 1순위 경쟁률 높은 순. */
export function ApplyhomeCompetitionSection({ filter }: { filter: PresaleFilter }) {
  const query = useApplyhome();
  const items = (query.data?.competition ?? []).filter(matches(filter));
  if (query.isError || query.isLoading || items.length === 0) return null;

  return (
    <LabSection
      title="최근 30일 경쟁률 높은 곳"
      tip={
        <p>
          최근 30일 안에 1순위 접수가 끝난 분양 공고입니다. 경쟁률은 1순위 접수 건수(해당지역·기타지역 합)를
          일반공급 세대수로 나눈 값이고, 일반공급 10세대 미만인 공고는 뺐습니다.
        </p>
      }
    >
      <MoreList
        key={`${filter.metro}|${filter.supplier}`}
        items={items}
        render={(n) => <RateRow key={n.id} n={n} />}
      />
    </LabSection>
  );
}
