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
          : // Layout height stays compact (contextual to title); ::before expands the
            // hit target to ~36px without adding visual section gap.
            `relative inline-flex w-fit max-w-full shrink-0 items-center gap-1 self-start rounded-md text-[13px] font-medium leading-none text-slate-600 transition hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-[''] ${className}`.trim()
      }
    >
      <ArrowLeft
        className={compact ? "h-4 w-4 shrink-0" : "h-3.5 w-3.5 shrink-0"}
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
