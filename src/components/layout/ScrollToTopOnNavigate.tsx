"use client";

import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * 페이지(pathname) 이동 시 항상 스크롤 최상단.
 * 브라우저 복원·로드 프로그레스로 헤더 높이가 바뀌며 중간에서 시작하는 문제를 막는다.
 * 쿼리만 바뀌는 경우(스크롤 유지 의도)는 건드리지 않는다.
 */
export function ScrollToTopOnNavigate() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;

    try {
      if ("scrollRestoration" in window.history) {
        window.history.scrollRestoration = "manual";
      }
    } catch {
      /* ignore */
    }

    const toTop = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    toTop();
    const raf = window.requestAnimationFrame(toTop);
    const t0 = window.setTimeout(toTop, 0);
    // 프로그레스바 마운트로 레이아웃이 밀린 뒤 한 번 더
    const t1 = window.setTimeout(toTop, 50);
    const t2 = window.setTimeout(toTop, 120);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [pathname]);

  return null;
}
