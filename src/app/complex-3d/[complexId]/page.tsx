import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { Complex3dPage } from "@/components/complex-3d/Complex3dPage";
import { getDb } from "@/lib/db/client";
import { groupPrimaryOf } from "@/lib/complex-group/groups";

export const metadata: Metadata = {
  title: "3D 단지 탐색 - 집랩",
  description: "실제 높이로 세운 단지 모형에서 층별 시세, 일조, 조망, 주변 시설을 살펴보세요.",
};

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ complexId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { complexId } = await params;
  // 단지 묶음 멤버 → 대표 단지 3D (멤버 동이 모두 대표 단지 모형에 들어 있다)
  const db = /^cx_[0-9a-f]{16}$/.test(complexId) ? getDb() : null;
  const primary = db ? await groupPrimaryOf(db, complexId).catch(() => null) : null;
  if (primary) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(await searchParams)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else if (v != null) qs.set(k, v);
    }
    permanentRedirect(`/complex-3d/${primary}${qs.size ? `?${qs}` : ""}`);
  }
  return (
    <main className="flex-1">
      {/* 바닥 위성영상 — 브이월드 브라우저용 키(도메인에 묶임) */}
      <Complex3dPage complexId={complexId} satelliteKey={process.env.VWORLD_WEB_KEY?.trim() || null} />
    </main>
  );
}
