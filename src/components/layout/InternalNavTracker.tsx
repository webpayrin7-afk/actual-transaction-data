"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  INTERNAL_CUR_URL_KEY,
  INTERNAL_PREV_URL_KEY,
  currentAppUrl,
} from "@/lib/nav/internal-nav";

/**
 * Records previous same-tab app URLs in sessionStorage so BackLink can
 * decide between router.back() and a safe parent fallback.
 */
export function InternalNavTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = currentAppUrl(pathname, searchParams.toString());
    try {
      const cur = sessionStorage.getItem(INTERNAL_CUR_URL_KEY);
      if (cur && cur !== next) {
        sessionStorage.setItem(INTERNAL_PREV_URL_KEY, cur);
      }
      sessionStorage.setItem(INTERNAL_CUR_URL_KEY, next);
    } catch {
      /* private mode / blocked storage */
    }
  }, [pathname, searchParams]);

  return null;
}
