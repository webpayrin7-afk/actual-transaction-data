"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { labTabId, labTabPanelId } from "@/components/ui/LabTabs";

/**
 * 1차 페이지 탭 — 페이지 맨 위 보기 전환 (예: 분양 [청약 일정 | 분양 결과 | 입주 예정]).
 * 전체 폭 칸(같은 비율) + 얇은 바닥선, 선택 = 청록 글자 + 칸 전체 폭의 둥근 청록 막대(3px). 막대는 탭을 바꿀 때 미끄러진다.
 * 안쪽 2차 탭(LabTabs segmented)·조건 칩과 모양을 달리해 위계를 나눈다. 페이지당 한 번만 쓴다.
 */
export function LabPageTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  idPrefix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number; ready: boolean }>({ left: 0, width: 0, ready: false });

  // 선택된 탭 칸의 위치·폭을 재서 막대를 옮긴다 (첫 배치는 애니메이션 없이).
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const cell = root.querySelector<HTMLElement>(`[data-tab-id="${value}"]`);
      if (!cell) return;
      const r = root.getBoundingClientRect();
      const l = cell.getBoundingClientRect();
      setBar((prev) => ({ left: l.left - r.left, width: l.width, ready: prev.width > 0 }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, items]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = items.findIndex((x) => x.id === value);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    onChange(items[next]!.id);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="relative -mx-4 flex border-b border-[color:var(--lab-border)] sm:mx-0"
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab-id={item.id}
            id={labTabId(idPrefix, item.id)}
            aria-selected={active}
            aria-controls={labTabPanelId(idPrefix, item.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={`flex h-12 flex-1 items-center justify-center text-[16px] leading-6 transition-colors duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
              active
                ? "font-bold text-[color:var(--lab-teal-700)]"
                : "font-medium text-[color:var(--lab-muted)] hover:text-[color:var(--lab-navy-950)]"
            }`}
          >
            {item.label}
          </button>
        );
      })}
      <span
        aria-hidden
        className={`pointer-events-none absolute bottom-0 translate-y-px rounded-full bg-[color:var(--lab-brand-primary)] motion-reduce:transition-none ${
          bar.ready ? "transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]" : ""
        }`}
        style={{ left: bar.left, width: bar.width, height: 3, opacity: bar.width ? 1 : 0 }}
      />
    </div>
  );
}
