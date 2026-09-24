"use client";

import { useMemo, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
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
  type RangeValue,
} from "@/lib/map/map-filters";

function summary(def: RangeFilterDef, r: RangeValue | undefined): string {
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
      <div className="flex h-12 items-end gap-[2px]" aria-hidden>
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
            className="absolute text-[12px] leading-4 text-[color:var(--lab-muted)] tabular-nums"
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

/** 지도 조건 시트 — 레시피 · 실시간 개수 · 가격/단지/환경. 바꾸는 즉시 지도에 반영된다. */
export function MapConditionSheet({
  open,
  onClose,
  conditions,
  onChange,
  complexes,
}: {
  open: boolean;
  onClose: () => void;
  conditions: MapConditions;
  onChange: (next: MapConditions) => void;
  /** 지금 화면에서 받은 단지 (분포·개수 계산용) */
  complexes: MapComplex[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const defs = useMemo(() => rangeDefs(conditions.deal), [conditions.deal]);
  const matched = complexes.filter((c) => matches(c, conditions, defs)).length;

  const setRange = (def: RangeFilterDef, v: RangeValue) => {
    const full = v.min <= def.min && v.max >= def.max;
    const ranges = { ...conditions.ranges };
    if (full) delete ranges[def.id];
    else ranges[def.id] = v;
    onChange({ ...conditions, ranges });
  };

  return (
    <LabBottomSheet
      open={open}
      onClose={onClose}
      title="조건으로 찾기"
      hideHeaderDivider
      compactBodyTop
      doneLabel="닫기"
      titleNote="막대는 지금 화면 속 단지 분포"
      footer={
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_CONDITIONS, deal: conditions.deal })}
            className="lab-button lab-button-secondary"
          >
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            초기화
          </button>
          <button type="button" onClick={onClose} className="lab-button lab-button-primary tabular-nums">
            {matched.toLocaleString("ko-KR")}곳 보기
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 pb-2">
        {/* 레시피: 한 줄 칩. 켠 레시피가 무엇을 걸었는지는 칩 아래 한 줄로만 */}
        <div className="flex flex-col gap-1.5">
          <div
            className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-0.5"
            style={{ scrollbarWidth: "none" }}
            role="group"
            aria-label="레시피"
          >
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
                      : "border-[color:var(--lab-border)] font-medium text-[color:var(--lab-navy-950)]"
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

        {FILTER_GROUPS.map((g) => (
          <section key={g.id} className="flex flex-col gap-1.5" aria-label={g.label}>
            {/* 묶음 이름은 작은 회색 캡션, 조건들은 그 아래 카드 — 위계를 모양으로 구분 */}
            <h4 className="px-1 text-[13px] font-semibold leading-5 text-[color:var(--lab-muted)]">{g.label}</h4>
            <ul className="divide-y divide-[color:var(--lab-border)] rounded-xl border border-[color:var(--lab-border)] px-3">
              {defs
                .filter((d) => d.group === g.id)
                .map((d) => {
                  const cur = conditions.ranges[d.id];
                  const isOpen = expanded === d.id;
                  const active = !isFullRange(d, cur);
                  const vals = complexes
                    .map((c) => d.value(c, conditions.deal))
                    .filter((v): v is number => v != null);
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : d.id)}
                        className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[15px] font-medium leading-6 text-[color:var(--lab-navy-950)]">
                            {d.label}
                          </span>
                          {d.hint || d.sparse ? (
                            <span className="detail-meta truncate">
                              {[d.hint, d.sparse ? "정보 있는 단지만" : null].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <span
                            className={`text-[14px] tabular-nums ${
                              active ? "font-semibold text-[color:var(--lab-teal-700)]" : "text-[color:var(--lab-muted)]"
                            }`}
                          >
                            {summary(d, cur)}
                          </span>
                          <ChevronDown
                            className={`h-4 w-4 text-[color:var(--lab-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`}
                            aria-hidden
                          />
                        </span>
                      </button>
                      {isOpen ? (
                        <div className="flex flex-col gap-2 pb-4">
                          <DistributionRange
                            def={d}
                            value={cur ?? { min: d.min, max: d.max }}
                            values={vals}
                            onChange={(v) => setRange(d, v)}
                          />
                          {d.id === "gap" ? (
                            <button
                              type="button"
                              aria-pressed={cur?.max === 0 && cur.min === d.min}
                              onClick={() =>
                                setRange(
                                  d,
                                  cur?.max === 0 && cur.min === d.min ? { min: d.min, max: d.max } : { min: d.min, max: 0 },
                                )
                              }
                              className="self-start rounded-full border border-[color:var(--lab-border)] px-3 py-2 text-[14px] font-medium aria-pressed:border-[color:var(--lab-brand-primary)] aria-pressed:text-[color:var(--lab-teal-700)]"
                            >
                              전세가 매매가 이상(역전)만
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              {g.id === "env" ? (
                <li className="flex flex-col gap-2 py-3">
                  <span className="text-[15px] font-medium leading-6 text-[color:var(--lab-navy-950)]">난방방식</span>
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
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
    </LabBottomSheet>
  );
}
