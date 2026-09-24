"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GuLeadersResponse } from "@/lib/complexes/gu-leaders";
import { formatEok } from "@/lib/utils/format";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabFilterChips } from "@/components/ui/LabFilterChips";
import { METRO_LABELS } from "@/lib/constants/regions";

/** 구별 종합 랭킹이 발행된 시·도 (강원·전북·광주·전남은 단지 목록 정비 전이라 아직 없음) */
const METROS = [
  "seoul", "gyeonggi", "incheon", "busan", "daegu", "daejeon", "ulsan", "sejong",
  "chungbuk", "chungnam", "gyeongbuk", "gyeongnam", "jeju",
] as const;
const METRO_OPTIONS = METROS.map((m) => ({ id: m as string, label: METRO_LABELS[m] }));

async function fetchLeaders(metro: string): Promise<GuLeadersResponse> {
  const res = await fetch(`/api/complexes/gu-leaders?metro=${metro}`);
  if (!res.ok) throw new Error("대장 단지를 불러오지 못했습니다.");
  return res.json();
}

/** 지도 왕관 1위와 같은 금색 왕관 */
function Crown() {
  return (
    <svg width="18" height="13" viewBox="0 0 24 17" aria-hidden className="mr-1.5 inline-block align-[-1px]">
      <path
        d="M2 15 L1 4 L6 8 L8.5 1.5 L12 7 L15.5 1.5 L18 8 L23 4 L22 15 Z"
        fill="#F6C343"
        stroke="#A86B00"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11.2" r="1.6" fill="#E5484D" />
    </svg>
  );
}

function perPyeong(man: number): string {
  return man >= 10_000 ? `${(man / 10_000).toFixed(2)}억` : `${man.toLocaleString("ko-KR")}만`;
}

/** 단지 조회 — 구마다 종합 1위 단지 (평당가 높은 구부터). 지도 왕관 1위와 같은 순위. */
export function GuLeaderList() {
  const [metro, setMetro] = useState<string>("seoul");
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === metro;
  const query = useQuery({
    queryKey: ["gu-leaders", metro],
    queryFn: () => fetchLeaders(metro),
    staleTime: 30 * 60_000,
    placeholderData: (prev) => prev,
  });
  const items = query.data?.items ?? [];
  if (query.isError) return null;
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      title="구별 대장 단지"
      tip={
        <p>
          구마다 집랩 종합 랭킹 1위 단지입니다. 최근 12개월 평당가(50%)·거래량(20%)·세대수(20%)·회전율(10%)을 같은 구
          단지끼리 비교했습니다. 지도에서 금색 왕관이 붙은 단지와 같습니다. 목록은 평당가가 높은 구부터입니다.
        </p>
      }
    >
      <LabFilterChips
        ariaLabel="대장 단지 지역"
        filters={[
          {
            key: "metro",
            title: "지역",
            options: METRO_OPTIONS,
            value: metro,
            defaultId: "",
            onChange: setMetro,
            grid: true,
          },
        ]}
      />
      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : items.length === 0 ? (
        <p className="detail-body">이 지역은 아직 랭킹 대상 단지가 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((item) => (
              <LabListRow
                key={item.complexId}
                href={item.href}
                title={
                  <>
                    <Crown />
                    {item.aptName}
                  </>
                }
                meta={[
                  [item.guName, item.dong].filter(Boolean).join(" "),
                  item.households ? `${item.households.toLocaleString("ko-KR")}세대` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={item.medianDealAmount != null ? formatEok(item.medianDealAmount) : "—"}
                sub={`평당 ${perPyeong(item.medianPerPyeong)}`}
              />
            ))}
          </ul>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpandedFor(expanded ? null : metro)}
              label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}
