"use client";

import { useState, useSyncExternalStore } from "react";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import {
  getSavedComplexesServerSnapshot,
  getSavedComplexesSnapshot,
  savedComplexHref,
  subscribeSavedComplexes,
} from "@/lib/complexes/saved-complexes";
import { formatDealDate, formatEok } from "@/lib/utils/format";

/** 단지별 조회 — 관심 단지. 저장한 것이 없으면 섹션을 숨긴다. */
export function SavedComplexList() {
  const [expanded, setExpanded] = useState(false);
  const items = useSyncExternalStore(
    subscribeSavedComplexes,
    getSavedComplexesSnapshot,
    getSavedComplexesServerSnapshot,
  );
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      title="관심 단지"
      meta={`${items.length}곳`}
    >
      <ul className={LAB_LIST}>
        {visible.map((item) => (
          <LabListRow
            key={`${item.regionSlug}-${item.aptName}-${item.gu ?? ""}`}
            href={savedComplexHref(item)}
            title={item.aptName}
            meta={[item.regionLabel, item.snapshot?.areaLabel].filter(Boolean).join(" · ")}
            value={item.snapshot?.latestTradeMan ? formatEok(item.snapshot.latestTradeMan) : undefined}
            sub={item.snapshot?.latestTradeDate ? `최근 매매 ${formatDealDate(item.snapshot.latestTradeDate)}` : undefined}
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
