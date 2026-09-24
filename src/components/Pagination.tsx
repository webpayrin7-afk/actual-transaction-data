"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  page: number;
  totalPages: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  totalCount,
  onPageChange,
}: PaginationProps) {
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const pages = buildPageWindow(page, totalPages);

  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <p className="detail-meta tabular-nums">
        총 <span className="font-semibold text-[color:var(--lab-navy-950)]">{totalCount.toLocaleString("ko-KR")}</span>건 ·{" "}
        {page} / {totalPages} 페이지
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-body)] transition before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="이전 페이지"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {pages.map((p, idx) =>
          p === "..." ? (
            <span
              key={`ellipsis-${idx}`}
              className="detail-meta px-1"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
              className={`lab-choice relative inline-flex h-9 min-h-9 min-w-9 px-2 text-[14px] tabular-nums before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
                p === page ? "lab-choice-selected" : ""
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-body)] transition before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="다음 페이지"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function buildPageWindow(
  current: number,
  total: number,
): Array<number | "..."> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  if (current <= 4) {
    return [1, 2, 3, 4, 5, "...", total];
  }

  if (current >= total - 3) {
    return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  }

  return [1, "...", current - 1, current, current + 1, "...", total];
}
