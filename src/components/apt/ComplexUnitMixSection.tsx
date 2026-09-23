"use client";

import { useState } from "react";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import {
  areaSelectorExclusiveLabel,
  areaSelectorPyeongLabel,
  representativePyeongFromSupplySqm,
} from "@/lib/apt/area-selector-label";
import type { ComplexUnitMixV1 } from "@/lib/complex-detail/get-complex-detail-v1";
import type { AptAreaOption } from "@/lib/molit/apt-client";

type MixGroup = {
  key: string;
  /** Matching 면적 선택 option, when one covers these unit types. */
  area: AptAreaOption | null;
  title: string;
  meta: string;
  householdCount: number;
};

function areaContains(area: AptAreaOption, exclusiveSqm: number): boolean {
  const min = area.exclusiveAreaMin ?? area.exclusiveArea;
  const max = area.exclusiveAreaMax ?? area.exclusiveArea;
  return exclusiveSqm >= min - 0.5 && exclusiveSqm <= max + 0.5;
}

/**
 * 평형 구성을 면적 선택과 같은 묶음으로 보여준다.
 * 거래 없는 평형은 면적 선택에 없으므로 전용면적 단위로 따로 둔다.
 */
function buildGroups(unitMix: ComplexUnitMixV1, areas: AptAreaOption[]): MixGroup[] {
  const groups = new Map<string, MixGroup>();
  for (const row of unitMix.rows) {
    const area = areas.find((a) => areaContains(a, row.exclusiveSqm)) ?? null;
    const key = area ? `area:${area.key}` : `sqm:${row.exclusiveSqm.toFixed(0)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.householdCount += row.householdCount;
      continue;
    }
    const pyeong = area
      ? areaSelectorPyeongLabel(area)
      : row.supplySqm
        ? `${representativePyeongFromSupplySqm(row.supplySqm, row.supplySqm)}평`
        : null;
    groups.set(key, {
      key,
      area,
      title: pyeong ?? `전용 ${row.exclusiveSqm.toFixed(0)}㎡`,
      meta: area ? areaSelectorExclusiveLabel(area) : `전용 ${row.exclusiveSqm.toFixed(2)}㎡`,
      householdCount: row.householdCount,
    });
  }
  return [...groups.values()];
}

export function ComplexUnitMixSection({
  unitMix,
  areas,
  areaKey,
  onAreaChange,
}: {
  unitMix: ComplexUnitMixV1 | null | undefined;
  areas: AptAreaOption[];
  areaKey: string;
  onAreaChange: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!unitMix || unitMix.rows.length === 0) return null;

  const groups = buildGroups(unitMix, areas);
  const total = groups.reduce((s, g) => s + g.householdCount, 0);
  if (total <= 0) return null;
  const maxCount = Math.max(...groups.map((g) => g.householdCount));
  const visible = expanded ? groups : groups.slice(0, LAB_LIST_PREVIEW);
  const hidden = groups.length - LAB_LIST_PREVIEW;

  return (
    <LabSection
      id="section-unit-mix"
      title="평형 구성"
      meta={`총 ${total.toLocaleString("ko-KR")}세대`}
      tip="건축물대장 전유부 기준 평형별 세대수입니다. 평형을 누르면 시세·계산기가 그 면적으로 바뀝니다."
    >
      <ul className={LAB_LIST}>
        {visible.map((g) => {
          const pct = Math.round((g.householdCount / total) * 100);
          const selected = g.area != null && g.area.key === areaKey;
          return (
            <LabListRow
              key={g.key}
              title={g.title}
              meta={g.meta}
              value={`${g.householdCount.toLocaleString("ko-KR")}세대`}
              sub={`${pct}%`}
              selected={selected}
              onClick={g.area ? () => onAreaChange(g.area!.key) : undefined}
            >
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
                aria-hidden
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(g.householdCount / maxCount) * 100}%`,
                    background: "var(--lab-brand-primary)",
                    opacity: selected ? 1 : 0.45,
                  }}
                />
              </div>
            </LabListRow>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          label={`${hidden}개 평형 더보기`}
        />
      ) : null}
      {unitMix.sourceAsOf ? (
        <p className="detail-meta">건축물대장 · {unitMix.sourceAsOf} 기준</p>
      ) : null}
    </LabSection>
  );
}
