"use client";

import { ChevronRight } from "lucide-react";

export const LIST_PREVIEW = 5;

export function ListMoreButton({
  expanded,
  onToggle,
  label = "더보기",
}: {
  expanded: boolean;
  onToggle: () => void;
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
