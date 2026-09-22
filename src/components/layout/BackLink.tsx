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
  /** Keep the back button but hide its text below the sm breakpoint. */
  hideLabelOnMobile?: boolean;
  /** Icon-only (e.g. beside a page title). */
  hideLabel?: boolean;
  /**
   * Always navigate to fallback (skip history.back).
   * Use when the parent URL must carry query state (e.g. ?nearbyTab=school).
   * Uses replace so the leaf page (e.g. school detail) does not sit under
   * the restored parent in history.
   */
  preferFallback?: boolean;
};

/**
 * Contextual back: uses browser history when this tab navigated from another
 * internal URL; otherwise goes to fallback (never external).
 */
export function BackLink({
  fallback,
  className = "",
  compact = false,
  hideLabelOnMobile = false,
  hideLabel = false,
  preferFallback = false,
}: BackLinkProps) {
  const router = useRouter();

  function goBack() {
    if (!preferFallback) {
      const cur =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "";
      if (canUseInternalHistoryBack(cur)) {
        router.back();
        return;
      }
    }
    if (preferFallback) {
      router.replace(fallback);
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
        compact || hideLabel
          ? `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--lab-radius-sm)] text-[color:var(--lab-navy-950)] hover:bg-[color:var(--lab-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${className}`.trim()
          : `relative inline-flex min-h-11 w-fit max-w-full shrink-0 items-center gap-1.5 self-start rounded-[var(--lab-radius-sm)] px-2.5 detail-label font-medium text-[color:var(--lab-body)] transition hover:text-[color:var(--lab-navy-950)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] ${className}`.trim()
      }
    >
      <ArrowLeft
        className={compact || hideLabel ? "h-5 w-5 shrink-0" : "h-4 w-4 shrink-0"}
        strokeWidth={2}
        aria-hidden
      />
      {hideLabel ? null : (
        <span className={hideLabelOnMobile ? "hidden sm:inline" : undefined}>
          돌아가기
        </span>
      )}
    </button>
  );
}
