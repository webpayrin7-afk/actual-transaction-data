"use client";

import { useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import {
  clearRecentComplexes,
  getRecentComplexesServerSnapshot,
  getRecentComplexesSnapshot,
  recentComplexHref,
  subscribeRecentComplexes,
} from "@/lib/complexes/recent-views";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";

export function RecentComplexList() {
  const [expanded, setExpanded] = useState(false);
  const items = useSyncExternalStore(
    subscribeRecentComplexes,
    getRecentComplexesSnapshot,
    getRecentComplexesServerSnapshot,
  );
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  // 본 단지가 없으면 섹션을 숨긴다 (관심 단지와 같은 규칙).
  if (items.length === 0) return null;

  return (
    <section aria-label="최근 조회한 단지" className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}>
      <div className="flex items-center justify-between gap-3">
        <LabSectionHeader
          title="최근 조회한 단지"
        />
        {items.length > 0 ? (
          <button
            type="button"
            onClick={() => clearRecentComplexes()}
            className="detail-label inline-flex min-h-11 shrink-0 items-center gap-1 px-1 transition hover:text-slate-800"
          >
            <X className="h-4 w-4" aria-hidden />
            전체 삭제
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="detail-body">
          아직 조회한 단지가 없습니다. 위 검색에서 궁금한 아파트를 찾아보세요.
        </p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((item) => (
              <LabListRow
                key={`${item.regionSlug}-${item.aptName}-${item.gu ?? ""}`}
                href={recentComplexHref(item)}
                title={item.aptName}
                meta={item.regionLabel}
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
    </section>
  );
}
