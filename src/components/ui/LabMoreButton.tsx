"use client";

import { ChevronRight } from "lucide-react";

/** 목록 기본 노출 개수 (policy §12.3). */
export const LAB_LIST_PREVIEW = 5;

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
      className="lab-button lab-button-secondary w-full"
    >
      {expanded ? "접기" : label}
      <ChevronRight
        className={`h-4 w-4 transition ${expanded ? "-rotate-90" : "rotate-90"}`}
        aria-hidden
      />
    </button>
  );
}
