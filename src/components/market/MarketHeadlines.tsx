"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabTabs, labTabPanelId } from "@/components/ui/LabTabs";
import type { HeadlineItem, HeadlinesResponse, HeadlineTopic } from "@/lib/market/naver-news";

async function fetchHeadlines(): Promise<HeadlinesResponse> {
  const res = await fetch("/api/market-headlines");
  if (!res.ok) throw new Error("뉴스를 불러오지 못했습니다.");
  return res.json();
}

type TopicFilter = "all" | HeadlineTopic;
const TAB_PREFIX = "market-headlines";

/** "3분 전", "2시간 전", 하루 넘으면 "어제 14:05" / "9월 22일" */
function timeAgo(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 60) return `${Math.max(1, min)}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  const d = new Date(t + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
}

function HeadlineRow({ item, now }: { item: HeadlineItem; now: number }) {
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
          <p className="detail-meta mt-0.5 tabular-nums">
            {[item.press, timeAgo(item.publishedAt, now)].filter(Boolean).join(" · ")}
          </p>
        </div>
        <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <span className="sr-only">(새 창에서 기사 열기)</span>
      </a>
    </li>
  );
}

/**
 * 부동산 뉴스 — NAVER 뉴스 검색(최근 48시간) 주제별 최신 헤드라인.
 * 제목·언론사·시각만 보이고 기사는 원문(새 창)에서 읽는다. 키가 없거나 실패하면 섹션을 숨긴다.
 */
export function MarketHeadlines({ id }: { id?: string }) {
  const query = useQuery({
    queryKey: ["market-headlines"],
    queryFn: fetchHeadlines,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const [filter, setFilter] = useState<TopicFilter>("all");
  const [expanded, setExpanded] = useState(false);
  const data = query.data?.status === "ok" ? query.data : null;
  // 렌더 시점 기준 — "N분 전" 표기용 (새로 불러올 때 갱신).
  const now = useMemo(() => (data ? Date.parse(data.fetchedAt) : 0), [data]);

  const tabs = useMemo(() => {
    if (!data) return [];
    return [
      { id: "all" as TopicFilter, label: "전체", count: String(data.items.length) },
      ...data.topics
        .filter((t) => t.count > 0)
        .map((t) => ({ id: t.key as TopicFilter, label: t.label, count: String(t.count) })),
    ];
  }, [data]);

  if (query.isError || query.data?.status === "unconfigured") return null;
  if (data && data.items.length === 0 && data.topics.every((t) => !t.ok)) return null;

  const activeFilter = tabs.some((t) => t.id === filter) ? filter : "all";
  const items = (data?.items ?? []).filter((i) => activeFilter === "all" || i.topic === activeFilter);
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const hidden = items.length - LAB_LIST_PREVIEW;

  return (
    <LabSection
      id={id}
      title="부동산 뉴스"
      meta="최근 48시간 · 최신순"
      tip={
        <p>
          네이버 뉴스 검색에서 부동산 정책·매매·전월세·대출 주제의 최신 기사를 모았습니다. 제목을
          누르면 기사가 새 창으로 열립니다. 기사 내용은 집랩이 요약하거나 저장하지 않습니다.
        </p>
      }
    >
      {query.isLoading ? <div className="lab-skeleton" aria-label="뉴스 불러오는 중" /> : null}
      {data ? (
        <>
          {tabs.length > 2 ? (
            <LabTabs
              variant="secondary"
              ariaLabel="뉴스 주제"
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
            id={tabs.length > 2 ? labTabPanelId(TAB_PREFIX, activeFilter) : undefined}
            role={tabs.length > 2 ? "tabpanel" : undefined}
          >
            {items.length === 0 ? (
              <p className="lab-state">최근 48시간 동안 해당 주제의 기사가 없습니다.</p>
            ) : (
              <ul className={LAB_LIST}>
                {visible.map((item) => (
                  <HeadlineRow key={item.id} item={item} now={now} />
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
        </>
      ) : null}
    </LabSection>
  );
}
