"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Box, ChevronRight } from "lucide-react";

/**
 * 3D 단지 탐색 들어가기 — 단지 상세 상단 카드 (집랩 핵심 콘텐츠라 청록 면으로 눈에 띄게).
 * 동 모양(GIS)이 하나도 없는 단지는 3D로 보여줄 게 없어 숨긴다 (타입·동 지도와 같은 요청·캐시).
 */
export function Complex3dEntryCard({ complexId }: { complexId: string }) {
  const q = useQuery({
    queryKey: ["complex-3d", complexId],
    queryFn: async () => {
      const res = await fetch(`/api/complex-3d/${complexId}?v=2`);
      return res.ok ? res.json() : null;
    },
    staleTime: 60 * 60 * 1000,
  });
  const withShape = (q.data as { coverage?: { withShape?: number } } | null)?.coverage?.withShape;
  if (q.isSuccess && !withShape) return null;
  return (
    <Link
      href={`/complex-3d/${complexId}`}
      className="lab-press flex min-h-16 items-center gap-3 px-3.5 py-3"
      style={{ background: "var(--lab-brand-subtle)", borderColor: "var(--lab-brand-border)" }}
    >
      <span
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white"
        style={{ background: "var(--lab-brand-primary)" }}
        aria-hidden
      >
        <Box className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-bold leading-6 text-[color:var(--lab-teal-700)]">3D로 단지 둘러보기</span>
        <span className="detail-meta block">실제 높이 · 층별 시세 · 일조 · 조망 · 주변</span>
      </span>
      <ChevronRight className="lab-press-arrow h-5 w-5 shrink-0" aria-hidden />
    </Link>
  );
}
