"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabTabs, labTabPanelId } from "@/components/ui/LabTabs";
import { LabTag } from "@/components/ui/LabTag";
import type {
  PolicyNewsItem,
  PolicyNewsResponse,
  PolicySourceKey,
} from "@/lib/market/policy-news";
import { seoulDateOf, seoulToday } from "@/lib/market/time";
import { LabDataLoading } from "@/components/ui/LabLoading";

async function fetchPolicyNews(): Promise<PolicyNewsResponse> {
  const res = await fetch("/api/market-news");
  if (!res.ok) throw new Error("정책 발표를 불러오지 못했습니다.");
  return res.json();
}

type SourceFilter = "all" | PolicySourceKey;

const TAB_PREFIX = "market-policy";

function dayLabel(iso: string, today: string): { label: string; isToday: boolean } {
  const day = seoulDateOf(iso);
  if (!day) return { label: "", isToday: false };
  if (day === today) return { label: "오늘", isToday: true };
  const t = new Date(`${today}T00:00:00+09:00`).getTime();
  const d = new Date(`${day}T00:00:00+09:00`).getTime();
  if (t - d === 86_400_000) return { label: "어제", isToday: false };
  const [, m, dd] = day.split("-");
  return { label: `${Number(m)}월 ${Number(dd)}일`, isToday: false };
}

function NewsRow({ item, today }: { item: PolicyNewsItem; today: string }) {
  const { label, isToday } = dayLabel(item.publishedAt, today);
  return (
    <li>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-11 items-start gap-3 py-2.5 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]"
      >
        <div className="min-w-0 flex-1">
          <p className="detail-data-value-emphasis line-clamp-2 break-keep">{item.title}</p>
          <p className="detail-meta mt-0.5 flex flex-wrap items-center gap-x-1.5 tabular-nums">
            {isToday ? <LabTag>오늘</LabTag> : null}
            <span>
              {item.sourceLabel}
              {isToday ? "" : ` · ${label}`}
            </span>
          </p>
        </div>
        <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <span className="sr-only">(새 창에서 원문 열기)</span>
      </a>
    </li>
  );
}

/**
 * 정책·규제 발표 — 부처 공식 RSS(국토부·금융위·재경부) 중 주거·대출 관련 제목만.
 * 제목과 원문 링크만 보여 준다. 실패하면 이 섹션만 조용히 안내한다.
 */
export function MarketPolicyNews({ id }: { id?: string }) {
  const query = useQuery({
    queryKey: ["market-news"],
    queryFn: fetchPolicyNews,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [expanded, setExpanded] = useState(false);
  const data = query.data;
  const today = seoulToday();

  const tabs = useMemo(() => {
    if (!data) return [];
    const withItems = data.sources.filter((s) => s.count > 0);
    if (withItems.length < 2) return [];
    return [
      { id: "all" as SourceFilter, label: "전체", count: String(data.items.length) },
      ...withItems.map((s) => ({
        id: s.key as SourceFilter,
        label: s.short,
        count: String(data.items.filter((i) => i.source === s.key).length),
      })),
    ];
  }, [data]);

  const activeFilter = tabs.some((t) => t.id === filter) ? filter : "all";
  const items = (data?.items ?? []).filter(
    (i) => activeFilter === "all" || i.source === activeFilter,
  );
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const hidden = items.length - LAB_LIST_PREVIEW;
  const failed = data?.sources.filter((s) => !s.ok) ?? [];
  const allFailed = data != null && failed.length === data.sources.length;

  return (
    <LabSection
      id={id}
      title="정책·규제 발표"
      tip={
        <p>
          국토교통부·금융위원회·재정경제부가 낸 보도자료 가운데 제목에 주택·부동산·대출 등
          주거 관련 단어가 들어간 것만 최신순으로 모았습니다. 제목을 누르면 부처 누리집의 원문이 새 창으로
          열립니다.
        </p>
      }
    >
      {query.isLoading ? <LabDataLoading label="정책 발표 불러오는 중" minHeight={240} /> : null}

      {query.isError || allFailed ? (
        <p className="lab-state">
          지금은 부처 발표를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.
        </p>
      ) : null}

      {data && !allFailed ? (
        <>
          {tabs.length > 0 ? (
            <LabTabs
              variant="secondary"
              ariaLabel="발표 기관"
              idPrefix={TAB_PREFIX}
              items={tabs}
              value={activeFilter}
              onChange={(next) => {
                setFilter(next);
                setExpanded(false);
              }}
            />
          ) : null}
          <div
            id={tabs.length > 0 ? labTabPanelId(TAB_PREFIX, activeFilter) : undefined}
            role={tabs.length > 0 ? "tabpanel" : undefined}
          >
            {items.length === 0 ? (
              <p className="lab-state">
                최근 부처 발표 중 주거·대출 관련 발표가 없습니다.
              </p>
            ) : (
              <ul className={LAB_LIST}>
                {visible.map((item) => (
                  <NewsRow key={item.id} item={item} today={today} />
                ))}
              </ul>
            )}
            {hidden > 0 ? (
              <LabMoreButton
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
                label={`${hidden}건 더보기`}
              />
            ) : null}
          </div>
          {failed.length > 0 ? (
            <p className="detail-meta">
              {failed.map((s) => s.label).join("·")} 발표는 지금 불러오지 못해 빠져 있습니다.
            </p>
          ) : null}
        </>
      ) : null}
    </LabSection>
  );
}
