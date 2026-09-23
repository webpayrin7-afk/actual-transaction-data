"use client";

import { useState } from "react";
import { LabDonut } from "@/components/ui/LabDonut";
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

/**
 * 평형은 작은 → 큰 순서가 있으므로 범주색 대신 청록 단계색(밝음 → 진함)을 쓴다.
 * 끝 두 색은 --lab-teal-600 / brand-hover 와 같은 계열.
 */
const UNIT_MIX_RAMP = ["#A7E8DF", "#6FD1C4", "#2FB3A6", "#0F8F86", "#0F766E", "#115E59", "#0B3F3C"];

function rampColors(n: number): string[] {
  if (n <= 1) return [UNIT_MIX_RAMP[4]!];
  const last = UNIT_MIX_RAMP.length - 1;
  // Spread evenly; skip the palest stop when few groups so every slice reads on white.
  const start = n <= 4 ? 1 : 0;
  return Array.from({ length: n }, (_, i) =>
    UNIT_MIX_RAMP[Math.round(start + (i * (last - start)) / (n - 1))]!,
  );
}

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
    const pyeong =
      (area ? areaSelectorPyeongLabel(area) : null) ??
      (row.supplySqm
        ? `${representativePyeongFromSupplySqm(row.supplySqm, row.supplySqm)}평`
        : null);
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
  complexHouseholdCount,
}: {
  unitMix: ComplexUnitMixV1 | null | undefined;
  areas: AptAreaOption[];
  areaKey: string;
  onAreaChange: (key: string) => void;
  /** 단지 전체 세대수(건축물대장 표제부). 확인된 평형 합계와 다르면 둘 다 보여준다. */
  complexHouseholdCount?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!unitMix || unitMix.rows.length === 0) return null;

  const groups = buildGroups(unitMix, areas);
  const total = groups.reduce((s, g) => s + g.householdCount, 0);
  if (total <= 0) return null;
  const colors = rampColors(groups.length);
  const selectedKey = groups.find((g) => g.area?.key === areaKey)?.key ?? null;
  const visible = expanded ? groups : groups.slice(0, LAB_LIST_PREVIEW);
  const hidden = groups.length - LAB_LIST_PREVIEW;
  const partial =
    complexHouseholdCount != null && complexHouseholdCount > total;

  return (
    <LabSection
      id="section-unit-mix"
      title="평형 구성"
      meta={
        partial
          ? `확인 ${total.toLocaleString("ko-KR")} / 전체 ${complexHouseholdCount!.toLocaleString("ko-KR")}세대`
          : `총 ${total.toLocaleString("ko-KR")}세대`
      }
      tip={
        partial
          ? "건축물대장 전유부에서 세대수가 확인된 평형만 보여줍니다. 비율은 확인된 세대 기준입니다. 평형을 누르면 시세·계산기가 그 면적으로 바뀝니다."
          : "건축물대장 전유부 기준 평형별 세대수입니다. 평형을 누르면 시세·계산기가 그 면적으로 바뀝니다."
      }
    >
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
        <LabDonut
          segments={groups.map((g, i) => ({
            key: g.key,
            value: g.householdCount,
            color: colors[i]!,
            dimmed: selectedKey != null && g.key !== selectedKey,
            label: g.title,
          }))}
          centerLabel={partial ? "확인 세대" : "총 세대"}
          centerValue={total.toLocaleString("ko-KR")}
        />
        <ul className={`${LAB_LIST} w-full min-w-0 flex-1`}>
          {visible.map((g) => {
            const i = groups.indexOf(g);
            const pct = Math.round((g.householdCount / total) * 100);
            return (
              <LabListRow
                key={g.key}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colors[i] }}
                      aria-hidden
                    />
                    <span className="truncate">{g.title}</span>
                  </span>
                }
                meta={g.meta}
                value={`${pct}%`}
                sub={`${g.householdCount.toLocaleString("ko-KR")}세대`}
                selected={g.key === selectedKey}
                onClick={g.area ? () => onAreaChange(g.area!.key) : undefined}
              />
            );
          })}
        </ul>
      </div>
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
