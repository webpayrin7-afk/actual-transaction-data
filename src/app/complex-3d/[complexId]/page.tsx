import type { Metadata } from "next";
import { Complex3dPage } from "@/components/complex-3d/Complex3dPage";

export const metadata: Metadata = {
  title: "3D 단지 탐색 - 집랩",
  description: "실제 높이로 세운 단지 모형에서 층별 시세, 일조, 조망, 주변 시설을 살펴보세요.",
};

export default async function Page({ params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  return (
    <main className="flex-1">
      {/* 바닥 위성영상 — 브이월드 브라우저용 키(도메인에 묶임) */}
      <Complex3dPage complexId={complexId} satelliteKey={process.env.VWORLD_WEB_KEY?.trim() || null} />
    </main>
  );
}
