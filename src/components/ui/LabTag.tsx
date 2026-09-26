"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * 테두리 태그 — 짧은 속성 나열. 줄바꿈 시 태그 단위로 넘어간다.
 * - sm: 목록 행의 근거 (예: "가격 상위 3%")
 * - md: 페이지 헤더의 요약 속성 (예: "429개 단지")
 * tone을 주면 색 배경 라벨이 된다 (brand 청록 · up 상승 · down 하락).
 */
export function LabTag({
  children,
  size = "sm",
  tone,
}: {
  children: ReactNode;
  size?: "sm" | "md";
  tone?: "brand" | "up" | "down";
}) {
  const scale =
    size === "md"
      ? "rounded-md px-1.5 text-[12px] leading-6"
      : "rounded px-1.5 text-[12px] leading-5";
  if (tone) {
    const c =
      tone === "up" ? "var(--lab-change-up)" : tone === "down" ? "var(--lab-change-down)" : "var(--lab-brand-primary)";
    return (
      <span
        className={`whitespace-nowrap border font-semibold tabular-nums ${scale}`}
        style={{
          color: c,
          background: `color-mix(in srgb, ${c} 9%, white)`,
          borderColor: `color-mix(in srgb, ${c} 28%, white)`,
        }}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className={`whitespace-nowrap border border-[color:var(--lab-border)] bg-white font-medium text-[color:var(--lab-body)] tabular-nums ${scale}`}
    >
      {children}
    </span>
  );
}

const CHIP =
  "inline-flex h-7 items-center gap-0.5 rounded-full border px-2.5 text-[13px] font-semibold leading-5 tabular-nums";

/**
 * 강조 라벨 칩 — 대표값 옆 순위·등급 (예: "서울 25개 구 중 3위").
 * `onToggle`을 주면 펼침 버튼이 되고(▾), 시각 28px + 숨은 영역으로 44px 터치를 확보한다.
 */
export function LabEmphasisChip({
  children,
  expanded,
  onToggle,
}: {
  children: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const style = {
    background: "var(--lab-brand-subtle)",
    borderColor: expanded ? "var(--lab-brand-primary)" : "var(--lab-brand-border)",
    color: "var(--lab-brand-primary)",
  };
  if (!onToggle) {
    return (
      <span className={CHIP} style={style}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={!!expanded}
      onClick={onToggle}
      className={`${CHIP} relative before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']`}
      style={style}
    >
      {children}
      <ChevronDown
        className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
        aria-hidden
      />
    </button>
  );
}
