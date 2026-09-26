"use client";

import { ChevronDown } from "lucide-react";

/** 목록 기본 노출 개수 (policy §12.4). */
export const LAB_LIST_PREVIEW = 5;

/** 더보기 버튼 스타일 — 목록을 더 펼치는 동작 전용. 실행·이동 버튼(lab-button-*)과 구분. */
export const LAB_MORE_BUTTON = "lab-more-button";

export function LabMoreButton({
  expanded,
  onToggle,
  label = "더보기",
}: {
  expanded: boolean;
  onToggle: () => void;
  /** e.g. "15곳 더보기" — include the remaining count when known. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={LAB_MORE_BUTTON}
    >
      {expanded ? "접기" : label}
      <ChevronDown
        className={`h-4 w-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
        aria-hidden
      />
    </button>
  );
}
