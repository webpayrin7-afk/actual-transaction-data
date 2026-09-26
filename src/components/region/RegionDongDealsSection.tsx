"use client";

import { useState } from "react";
import { LabDataLoading } from "@/components/ui/LabLoading";
import { LabSection } from "@/components/ui/LabSection";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { CONTRACT_DATE_BASIS_HELP } from "@/lib/region/market-insight";
import { rankingComplexHref } from "@/lib/region-ranking/public";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import type {
  RegionDongDeal,
  RegionDongOverview,
} from "@/lib/region/region-dong-overview";

const TABS = [
  { id: "trade", label: "매매" },
  { id: "rent", label: "전월세" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** 더보기 한 번에 붙이는 건수 (policy §12.4: 5건 시작 → 15건씩). */
const PAGE_STEP = 15;

function dealValue(deal: RegionDongDeal): string {
  if (deal.kind === "trade") return formatEok(deal.dealAmount);
  if (deal.kind === "jeonse") return `전세 ${formatEok(deal.dealAmount)}`;
  return `월세 ${formatEok(deal.dealAmount)}/${deal.monthlyRent.toLocaleString("ko-KR")}`;
}

/** 동 상세 — 최근 1년 실거래 (매매 / 전월세 각 최대 30건). */
export function RegionDongDealsSection({
  dong,
  data,
  loading,
  failed,
  regionSlug,
  guName,
}: {
  dong: string;
  data: RegionDongOverview | null;
  loading: boolean;
  failed: boolean;
  regionSlug: string;
  guName: string;
}) {
  const [tab, setTab] = useState<TabId>("trade");
  const [count, setCount] = useState(LAB_LIST_PREVIEW);
  const deals = data?.recentDeals[tab] ?? [];
  const visible = deals.slice(0, count);

  return (
    <LabSection
      id="dong-deals"
      label={`${dong} 최근 거래`}
      title="최근 거래"
      meta="계약일 기준 · 최근 1년"
      tip={
        <p>
          {dong} 아파트의 최근 실거래를 계약일 순으로 보여줍니다. {CONTRACT_DATE_BASIS_HELP}
        </p>
      }
    >
      <LabTabs
        variant="secondary"
        ariaLabel="최근 거래 유형"
        items={TABS}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setCount(LAB_LIST_PREVIEW);
        }}
      />
      {failed ? (
        <p className="detail-body">최근 거래를 불러오지 못했습니다.</p>
      ) : loading ? (
        <LabDataLoading label="거래 불러오는 중" minHeight={272} />
      ) : deals.length === 0 ? (
        <p className="detail-body">
          최근 1년 동안 {tab === "trade" ? "매매" : "전월세"} 거래가 없습니다.
        </p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((deal) => (
              <LabListRow
                key={deal.id}
                href={rankingComplexHref({
                  aptName: deal.aptName,
                  regionSlug,
                  gu: guName,
                  complexId: deal.complexId,
                })}
                title={deal.aptName || "—"}
                meta={[
                  `전용 ${Math.round(deal.exclusiveArea)}㎡`,
                  deal.floor != null ? `${deal.floor}층` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={dealValue(deal)}
                sub={formatDealDate(deal.dealDate)}
              />
            ))}
          </ul>
          {deals.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={count >= deals.length}
              onToggle={() =>
                setCount((c) => (c >= deals.length ? LAB_LIST_PREVIEW : c + PAGE_STEP))
              }
              label={`${Math.min(PAGE_STEP, deals.length - count).toLocaleString("ko-KR")}건 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}
