"use client";

import { useEffect } from "react";

/** 이 화면을 만든 배포 번호 (빌드 때 박힌다) */
const BUILT = process.env.NEXT_PUBLIC_DEPLOYMENT_ID ?? "";
/** 너무 자주 묻지 않게 */
const MIN_GAP_MS = 30_000;

/**
 * 새 배포가 올라갔는데 폰 브라우저가 탭을 메모리에 붙잡고 있어 예전 화면이 계속 보이는 문제 —
 * 탭으로 돌아올 때(보이게 될 때) 지금 배포 번호를 물어 다르면 새로고침한다.
 * 막 돌아온 순간이라 입력 중인 것이 없어 바로 새로고침해도 된다. 로컬 개발(번호 없음)에서는 하지 않는다.
 */
export function NewVersionReload() {
  useEffect(() => {
    if (!BUILT) return;
    let last = 0;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < MIN_GAP_MS) return;
      last = now;
      try {
        const res = await fetch("/api/build", { cache: "no-store" });
        if (!res.ok) return;
        const { id } = (await res.json()) as { id?: string };
        if (id && id !== "dev" && id !== BUILT) window.location.reload();
      } catch {
        /* 오프라인 등 — 다음에 */
      }
    };
    document.addEventListener("visibilitychange", check);
    // bfcache 로 되살아난 페이지(뒤로 가기·탭 복귀)도
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void check();
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return null;
}
