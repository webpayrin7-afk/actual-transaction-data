"use client";

import { useRouter } from "next/navigation";
import { canUseInternalHistoryBack } from "@/lib/nav/internal-nav";

type BackLinkProps = {
  /** Safe parent when no trusted internal history (e.g. /complexes, /regions) */
  fallback: string;
  /** Destination label after ‹ — e.g. "단지별 조회", "지역별 조회" */
  label: string;
  className?: string;
  /** Sticky-bar denser variant (same ~32px height) */
  compact?: boolean;
  /** Keep the control but hide label text below the sm breakpoint. */
  hideLabelOnMobile?: boolean;
};

/**
 * Contextual back: uses browser history when this tab navigated from another
 * internal URL; otherwise goes to fallback (never external).
 * Destination-named label — never generic "돌아가기".
 */
export function BackLink({
  fallback,
  label,
  className = "",
  compact = false,
  hideLabelOnMobile = false,
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
      aria-label={label}
      className={[
        "inline-flex shrink-0 items-center self-start rounded-full border border-[color:var(--lab-border)] bg-transparent font-medium text-[color:var(--lab-navy-900)] shadow-none transition",
        compact ? "h-8 gap-0.5 px-2.5 text-xs" : "h-8 gap-1 px-2.5 text-[13px] leading-none",
        "hover:border-[color:var(--lab-teal-600)]/35 hover:bg-[color:var(--lab-teal-50)] hover:text-[color:var(--lab-teal-700)]",
        "active:bg-[color:var(--lab-teal-50)] active:text-[color:var(--lab-teal-700)]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden className="text-[15px] leading-none">
        ‹
      </span>
      <span className={hideLabelOnMobile ? "hidden sm:inline" : undefined}>
        {label}
      </span>
    </button>
  );
}
