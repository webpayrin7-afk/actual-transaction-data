"use client";

import { useState } from "react";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import type { MarketRegionBreakdown as Breakdown } from "@/lib/market/home";

const METRO_TILES = 3;

function share(n: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = Math.round((n / total) * 100);
  return pct < 1 ? "<1%" : `${pct}%`;
}

/** 오늘 새로 확인된 매매가 어느 지역에서 나왔는지 — 시·도 합계 + 지역 순위 (5개 + 더보기). */
export function MarketRegionBreakdown({ id, data }: { id?: string; data: Breakdown }) {
  const [expanded, setExpanded] = useState(false);
  const { total, regions } = data;
  const metros =
    data.metros.length > METRO_TILES
      ? [
          ...data.metros.slice(0, METRO_TILES - 1),
          {
            key: "rest",
            label: "그 외",
            count: data.metros
              .slice(METRO_TILES - 1)
              .reduce((s, m) => s + m.count, 0),
          },
        ]
      : data.metros;
  const max = Math.max(1, ...regions.map((r) => r.count));
  const visible = expanded ? regions : regions.slice(0, LAB_LIST_PREVIEW);
  const hidden = regions.length - LAB_LIST_PREVIEW;

  return (
    <LabSection
      id={id}
      title="오늘 거래가 확인된 지역"
      meta={`${total.toLocaleString("ko-KR")}건 · ${regions.length}개 지역`}
      tip={
        <p>
          집랩이 오늘 처음 확인한 매매를 지역별로 센 값입니다. 확인한 날짜 기준이라 실제
          계약일은 거래마다 다릅니다.
        </p>
      }
    >
      {metros.length > 1 ? (
        <LabStatTiles
          layout="inline"
          columns={metros.length >= 3 ? 3 : 2}
          items={metros.map((m) => ({
            key: m.key,
            label: m.label,
            value: `${m.count.toLocaleString("ko-KR")}건`,
          }))}
        />
      ) : null}
      <ul className={LAB_LIST}>
        {visible.map((r) => (
          <LabListRow
            key={r.key}
            href={r.href}
            title={r.name}
            meta={r.metroLabel}
            value={`${r.count.toLocaleString("ko-KR")}건`}
            sub={share(r.count, total)}
          >
            <div
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
              aria-hidden
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (r.count / max) * 100)}%`,
                  background: "var(--lab-brand-primary)",
                }}
              />
            </div>
          </LabListRow>
        ))}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          label={`${hidden}개 지역 더보기`}
        />
      ) : null}
    </LabSection>
  );
}
