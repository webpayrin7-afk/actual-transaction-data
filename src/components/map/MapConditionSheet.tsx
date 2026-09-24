"use client";

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import type { MapComplex } from "@/lib/map/map-complexes";
import {
  EMPTY_CONDITIONS,
  FILTER_GROUPS,
  HEATING_KINDS,
  RECIPES,
  histogram,
  isFullRange,
  matches,
  rangeDefs,
  recipeActive,
  type MapConditions,
  type RangeFilterDef,
  type RangeFilterId,
  type RangeValue,
} from "@/lib/map/map-filters";

/** 조건 하나를 가리키는 키 — 범위 조건 또는 난방 */
export type ConditionKey = RangeFilterId | "heating";

/** "1,000세대 이상", "10~15억", "전체" */
export function conditionSummary(def: RangeFilterDef, r: RangeValue | undefined): string {
  if (isFullRange(def, r)) return "전체";
  const lo = r!.min > def.min ? def.format(r!.min) : null;
  const hi = r!.max < def.max ? def.format(r!.max) : null;
  if (lo && hi) return `${lo} ~ ${hi}`;
  if (lo) return `${lo} 이상`;
  return `${hi} 이하`;
}

/**
 * 분포가 보이는 범위 슬라이더 — 지금 화면 단지들의 값 분포(막대) 위에 두 손잡이.
 * 범위 안 막대는 진하게, 밖은 옅게.
 */
function DistributionRange({
  def,
  value,
  values,
  onChange,
}: {
  def: RangeFilterDef;
  value: RangeValue;
  values: number[];
  onChange: (v: RangeValue) => void;
}) {
  const bins = useMemo(() => histogram(values, def), [values, def]);
  const peak = Math.max(1, ...bins);
  const span = def.max - def.min;
  const pos = (v: number) => ((v - def.min) / span) * 100;
  const binWidth = span / bins.length;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-9 items-end gap-[2px]" aria-hidden>
        {bins.map((n, i) => {
          const lo = def.min + i * binWidth;
          const inRange = lo + binWidth > value.min && lo < (value.max >= def.max ? Infinity : value.max);
          return (
            <span
              key={i}
              className="flex-1 rounded-t-[2px]"
              style={{
                height: `${n === 0 ? 2 : Math.max(6, (n / peak) * 100)}%`,
                backgroundColor: inRange ? "var(--lab-brand-primary)" : "var(--lab-border)",
                opacity: n === 0 ? 0.5 : 1,
              }}
            />
          );
        })}
      </div>
      <div className="lab-dual-range relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[color:var(--lab-border)]" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[color:var(--lab-navy-950)]"
          style={{ left: `${pos(value.min)}%`, right: `${100 - pos(value.max)}%` }}
        />
        <input
          type="range"
          aria-label={`${def.label} 최소`}
          min={def.min}
          max={def.max}
          step={def.step}
          value={value.min}
          onChange={(e) => onChange({ min: Math.min(Number(e.target.value), value.max - def.step), max: value.max })}
        />
        <input
          type="range"
          aria-label={`${def.label} 최대`}
          min={def.min}
          max={def.max}
          step={def.step}
          value={value.max}
          onChange={(e) => onChange({ min: value.min, max: Math.max(Number(e.target.value), value.min + def.step) })}
        />
      </div>
      <div className="relative h-4">
        {def.ticks.map((t, i) => (
          <span
            key={t}
            className="absolute whitespace-nowrap text-[12px] leading-4 text-[color:var(--lab-muted)] tabular-nums"
            style={{
              left: `${pos(t)}%`,
              transform: i === 0 ? "none" : i === def.ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {(def.tick ?? def.format)(t)}
            {i === def.ticks.length - 1 ? "+" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 범위 조건 본문 — 분포 슬라이더 (+ 갭은 '역전만' 버튼) */
function RangeBody({
  def,
  conditions,
  complexes,
  onRange,
}: {
  def: RangeFilterDef;
  conditions: MapConditions;
  complexes: MapComplex[];
  onRange: (def: RangeFilterDef, v: RangeValue) => void;
}) {
  const cur = conditions.ranges[def.id];
  const vals = useMemo(
    () => complexes.map((c) => def.value(c, conditions.deal)).filter((v): v is number => v != null),
    [complexes, def, conditions.deal],
  );
  const inverseOnly = cur?.max === 0 && cur.min === def.min;
  return (
    <div className="flex flex-col gap-2">
      <DistributionRange def={def} value={cur ?? { min: def.min, max: def.max }} values={vals} onChange={(v) => onRange(def, v)} />
      {def.id === "gap" ? (
        <button
          type="button"
          aria-pressed={inverseOnly}
          onClick={() => onRange(def, inverseOnly ? { min: def.min, max: def.max } : { min: def.min, max: 0 })}
          className="self-start rounded-full border border-[color:var(--lab-border)] px-3 py-2 text-[14px] font-medium aria-pressed:border-[color:var(--lab-brand-primary)] aria-pressed:text-[color:var(--lab-teal-700)]"
        >
          전세가 매매가 이상(역전)만
        </button>
      ) : null}
    </div>
  );
}

function HeatingChips({
  conditions,
  onChange,
}: {
  conditions: MapConditions;
  onChange: (next: MapConditions) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {HEATING_KINDS.map((k) => {
        const on = conditions.heating.includes(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onChange({
                ...conditions,
                heating: on ? conditions.heating.filter((x) => x !== k) : [...conditions.heating, k],
              })
            }
            className={`min-h-11 rounded-full border px-4 text-[14px] font-medium ${
              on
                ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
                : "border-[color:var(--lab-border)] text-[color:var(--lab-navy-950)]"
            }`}
          >
            {k}난방
          </button>
        );
      })}
    </div>
  );
}

/**
 * 지도 조건 시트.
 * - 전체 모드(only 없음): 레시피 · 가격/단지/환경 전부 — 한 번에 바꾸기
 * - 하나 모드(only): 지도 위 칩에서 연 조건 하나만
 * 바꾸는 즉시 지도에 반영된다.
 */
export function MapConditionSheet({
  open,
  onClose,
  conditions,
  onChange,
  complexes,
  only = null,
}: {
  open: boolean;
  onClose: () => void;
  conditions: MapConditions;
  onChange: (next: MapConditions) => void;
  /** 지금 화면에서 받은 단지 (분포·개수 계산용) */
  complexes: MapComplex[];
  only?: ConditionKey | null;
}) {
  const defs = useMemo(() => rangeDefs(conditions.deal), [conditions.deal]);
  const matched = complexes.filter((c) => matches(c, conditions, defs)).length;
  const onlyDef = only && only !== "heating" ? defs.find((d) => d.id === only) ?? null : null;

  const setRange = (def: RangeFilterDef, v: RangeValue) => {
    const full = v.min <= def.min && v.max >= def.max;
    const ranges = { ...conditions.ranges };
    if (full) delete ranges[def.id];
    else ranges[def.id] = v;
    onChange({ ...conditions, ranges });
  };

  const resetScope = () => {
    if (!only) return onChange({ ...EMPTY_CONDITIONS, deal: conditions.deal });
    if (only === "heating") return onChange({ ...conditions, heating: [] });
    const ranges = { ...conditions.ranges };
    delete ranges[only];
    onChange({ ...conditions, ranges });
  };

  // 이동 목록: 묶음 순서(가격 → 단지 → 환경) 그대로 + 난방
  const jumpList = [
    ...FILTER_GROUPS.flatMap((g) =>
      defs
        .filter((d) => d.group === g.id)
        .map((d) => ({ id: d.id as string, label: d.label, active: !isFullRange(d, conditions.ranges[d.id]) })),
    ),
    { id: "heating", label: "난방", active: conditions.heating.length > 0 },
  ];

  const title = only ? (only === "heating" ? "난방방식" : (onlyDef?.label ?? "조건")) : "조건으로 찾기";

  return (
    <LabBottomSheet
      open={open}
      onClose={onClose}
      title={title}
      hideHeaderDivider
      compactBodyTop
      size={only ? "default" : "tall"}
      doneLabel="닫기"
      titleNote={only === "heating" ? undefined : "막대가 높을수록 단지가 많아요"}
      footer={
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <button type="button" onClick={resetScope} className="lab-button lab-button-secondary">
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            초기화
          </button>
          <button type="button" onClick={onClose} className="lab-button lab-button-primary tabular-nums">
            {matched.toLocaleString("ko-KR")}곳 보기
          </button>
        </div>
      }
    >
      {only ? (
        <div className="flex flex-col gap-3 pb-2">
          {onlyDef ? (
            <RangeBody def={onlyDef} conditions={conditions} complexes={complexes} onRange={setRange} />
          ) : (
            <HeatingChips conditions={conditions} onChange={onChange} />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-7 pb-4">
          {/* 필터 이동 — 탭 모양 글자 버튼, 스크롤해도 위에 고정(본문 위 여백 8px까지 덮도록 -top-2). 조건이 걸린 필터는 강조색 */}
          <nav aria-label="필터로 이동" className="sticky -top-2 z-10 -mx-4 -mt-2 -mb-3 bg-white px-4 pt-2">
            <div
              className="-mx-4 flex gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4"
              style={{ scrollbarWidth: "none" }}
            >
              {jumpList.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() =>
                    document.getElementById(`cond-${j.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={`inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap text-[14px] leading-5 ${
                    j.active
                      ? "font-semibold text-[color:var(--lab-teal-700)]"
                      : "font-medium text-[color:var(--lab-muted)]"
                  }`}
                >
                  {j.label}
                  {j.active ? (
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[color:var(--lab-brand-primary)]" />
                  ) : null}
                </button>
              ))}
            </div>
            <div aria-hidden className="-mx-4 h-px bg-[color:var(--lab-border)]" />
          </nav>

          {/* 레시피 — 이름표 + 연한 채움 칩(조건을 한 번에 적용). 이동 탭과 모양이 달라 섞이지 않는다 */}
          <div className="flex flex-col gap-1.5">
            <div
              className="-mx-4 flex items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 py-1"
              style={{ scrollbarWidth: "none" }}
              role="group"
              aria-label="레시피"
            >
              <span className="mr-1 shrink-0 text-[13px] font-semibold leading-5 text-[color:var(--lab-muted)]">
                레시피
              </span>
              {RECIPES.map((r) => {
                const on = recipeActive(r, conditions);
                return (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      if (on) {
                        // 레시피가 넣은 범위만 걷어낸다
                        const applied = r.apply({ ...conditions, ranges: {} });
                        const ranges = { ...conditions.ranges };
                        for (const k of Object.keys(applied.ranges)) delete ranges[k as keyof typeof ranges];
                        onChange({ ...conditions, ranges });
                      } else onChange(r.apply(conditions));
                    }}
                    className={`relative inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-[14px] leading-5 before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
                      on
                        ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
                        : "border-transparent bg-[color:var(--lab-surface-subtle)] font-medium text-[color:var(--lab-navy-950)]"
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
            {RECIPES.filter((r) => recipeActive(r, conditions)).map((r) => (
              <p key={r.id} className="detail-meta">
                {r.label} → {r.hint}
              </p>
            ))}
          </div>

          {FILTER_GROUPS.map((g, gi) => (
            <section
              key={g.id}
              aria-label={g.label}
              className={`flex flex-col gap-7 ${gi > 0 ? "border-t border-[color:var(--lab-border)] pt-6" : ""}`}
            >
              {/* 묶음 이름은 작은 회색 캡션. 조건은 항상 펼쳐 두고 구분선 대신 여백으로 나눈다. */}
              <h4 className="-mb-3 text-[13px] font-semibold leading-5 text-[color:var(--lab-muted)]">{g.label}</h4>
              {defs
                .filter((d) => d.group === g.id)
                .map((d) => {
                  const cur = conditions.ranges[d.id];
                  const active = !isFullRange(d, cur);
                  return (
                    <div key={d.id} id={`cond-${d.id}`} className="flex scroll-mt-16 flex-col gap-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 text-[16px] font-semibold leading-6 text-[color:var(--lab-navy-950)]">
                          {d.label}
                        </span>
                        <span
                          className={`shrink-0 text-[15px] tabular-nums ${
                            active ? "font-semibold text-[color:var(--lab-teal-700)]" : "text-[color:var(--lab-muted)]"
                          }`}
                        >
                          {conditionSummary(d, cur)}
                        </span>
                      </div>
                      <RangeBody def={d} conditions={conditions} complexes={complexes} onRange={setRange} />
                    </div>
                  );
                })}
              {g.id === "env" ? (
                <div id="cond-heating" className="flex scroll-mt-16 flex-col gap-2.5">
                  <span className="text-[16px] font-semibold leading-6 text-[color:var(--lab-navy-950)]">난방방식</span>
                  <HeatingChips conditions={conditions} onChange={onChange} />
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </LabBottomSheet>
  );
}
