"use client";

import { useRef, type KeyboardEvent } from "react";
import { labTabId, labTabPanelId } from "@/components/ui/LabTabs";

/**
 * 페이지 최상위 보기 전환 탭 — 전체 폭 밑줄형 (예: 분양 [청약 일정 | 분양 결과 | 입주 예정]).
 * 안쪽 조건·분류용 LabTabs(segmented)·필터 칩과 모양을 달리해 위계를 나눈다.
 * 선택 = navy 글자 700 + 2px navy 밑줄, 비선택 = 회색 500. 높이 48, 터치 44 이상.
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
      className="-mx-4 flex border-b border-[color:var(--lab-border)] sm:mx-0"
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={labTabId(idPrefix, item.id)}
            aria-selected={active}
            aria-controls={labTabPanelId(idPrefix, item.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={`relative flex h-12 flex-1 items-center justify-center text-[16px] leading-6 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${
              active
                ? "font-bold text-[color:var(--lab-navy-950)]"
                : "font-medium text-[color:var(--lab-muted)] hover:text-[color:var(--lab-navy-950)]"
            }`}
          >
            {item.label}
            <span
              aria-hidden
              className={`absolute inset-x-0 bottom-0 h-0.5 translate-y-px ${active ? "bg-[color:var(--lab-navy-950)]" : "bg-transparent"}`}
            />
          </button>
        );
      })}
    </div>
  );
}
