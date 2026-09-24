"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApplyhomeNotice, ApplyhomeOverview } from "@/lib/applyhome/read";
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

const md = (iso: string | null) => (iso ? iso.slice(5, 10).replace("-", ".") : "");
const ym = (v: string | null) => (v && v.length === 6 ? `${v.slice(0, 4)}.${v.slice(4)}` : "");

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** 억 한 자리: 50466 → "5", 216300 → "21.6" */
const eok1 = (man: number) => String(Math.round(man / 1000) / 10);

/** 분양가 범위 짧게: "5~7.2억", 1억 미만이 섞이면 "9,800만~1.2억" */
function priceRange(n: ApplyhomeNotice): string | null {
  const lo = n.priceMin;
  const hi = n.priceMax;
  if (lo == null) return null;
  const one = (v: number) => (v >= 10_000 ? `${eok1(v)}억` : `${v.toLocaleString("ko-KR")}만`);
  if (hi == null || hi === lo) return one(lo);
  return lo >= 10_000 ? `${eok1(lo)}~${eok1(hi)}억` : `${one(lo)}~${one(hi)}`;
}

/** 오른쪽 상태: 접수 중 / D-n */
function status(n: ApplyhomeNotice, today: string): { text: string; live: boolean } {
  const start = n.specialBegin ?? n.rceptBegin;
  if (start && start <= today) return { text: "접수 중", live: true };
  if (start) return { text: `D-${daysBetween(today, start)}`, live: false };
  return { text: "", live: false };
}

/** 민영은 기본이라 생략하고 국민(공공)·신혼희망타운 등만 붙인다 */
function metaOf(n: ApplyhomeNotice): string {
  const kind = n.kind?.replace(/(^| · )민영$/, "").replace(/ · 국민$/, "").replace(/^국민$/, "공공") || null;
  return [n.place, n.totalSupply ? `${n.totalSupply.toLocaleString("ko-KR")}세대` : null, kind]
    .filter(Boolean)
    .join(" · ");
}

/** 단지 조회 — 접수가 끝나지 않은 청약 (특별공급 시작일 순). 행은 청약홈 공고로 연결. */
export function ApplyhomeUpcomingSection() {
  const query = useApplyhome();
  const [expanded, setExpanded] = useState(false);
  const data = query.data;
  if (query.isError || (data && data.upcoming.length === 0)) return null;
  const items = data?.upcoming ?? [];
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      title="청약 일정"
      tip={
        <p>
          한국부동산원 청약홈에 올라온 분양 공고 중 접수가 끝나지 않은 곳입니다. 금액은 주택형별 최고 분양가의 범위이고,
          누르면 청약홈 공고가 새 창으로 열립니다.
        </p>
      }
    >
      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((n) => {
              const st = status(n, data!.today);
              return (
                <LabListRow
                  key={n.id}
                  href={n.url}
                  external
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
                  value={
                    <span style={st.live ? { color: "var(--lab-brand-primary)" } : undefined}>{st.text}</span>
                  }
                  sub={priceRange(n)}
                />
              );
            })}
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

/** 단지 조회 — 최근 30일 접수가 끝난 청약의 1순위 경쟁률 높은 순. */
export function ApplyhomeCompetitionSection() {
  const query = useApplyhome();
  const [expanded, setExpanded] = useState(false);
  const items = query.data?.competition ?? [];
  if (query.isError || query.isLoading || items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      title="최근 청약 경쟁률"
      tip={
        <p>
          최근 30일 안에 1순위 접수가 끝난 분양 공고입니다. 경쟁률은 1순위 접수 건수(해당지역·기타지역 합)를
          일반공급 세대수로 나눈 값이고, 일반공급 10세대 미만인 공고는 뺐습니다.
        </p>
      }
    >
      <ul className={LAB_LIST}>
        {visible.map((n) => (
          <LabListRow
            key={n.id}
            href={n.url}
            external
            wrap
            title={n.name}
            meta={
              <>
                <span className="block">{metaOf(n)}</span>
                <span className="block tabular-nums">
                  일반 {n.generalSupply.toLocaleString("ko-KR")}세대에 {n.firstRankRequests.toLocaleString("ko-KR")}명
                  {n.moveInYm ? ` · 입주 ${ym(n.moveInYm)}` : ""}
                </span>
              </>
            }
            value={`${n.rate.toLocaleString("ko-KR")}:1`}
            sub={priceRange(n)}
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
    </LabSection>
  );
}
