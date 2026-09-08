"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { canUseInternalHistoryBack } from "@/lib/nav/internal-nav";

type BackLinkProps = {
  /** Safe parent when no trusted internal history (e.g. /complexes, /regions) */
  fallback: string;
  className?: string;
  /** Compact sticky-bar style */
  compact?: boolean;
};

/**
 * Contextual back: uses browser history when this tab navigated from another
 * internal URL; otherwise goes to fallback (never external).
 */
export function BackLink({
  fallback,
  className = "",
  compact = false,
}: BackLinkProps) {
  const router = useRouter();

  function goBack() {
    const cur =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "";
    if (canUseInternalHistoryBack(cur)) {
      router.back();
      return;
    }
    router.push(fallback);
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="돌아가기"
      className={
        compact
          ? `inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${className}`.trim()
          : `inline-flex min-h-9 items-center gap-1 rounded-md text-sm font-medium text-slate-600 transition hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${className}`.trim()
      }
    >
      <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
      <span>돌아가기</span>
    </button>
  );
}
