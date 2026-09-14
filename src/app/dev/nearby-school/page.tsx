import type { Metadata } from "next";
import { NearbySchoolMapPilot } from "@/components/nearby-map/NearbySchoolMapPilot";

export const metadata: Metadata = {
  title: "DEV · 주변환경·학군 지도 파일럿 | ZIPLAB",
  robots: { index: false, follow: false },
};

/**
 * Isolated Phase 8.1 pilot — not linked from main navigation.
 * Future Complex Detail insertion: 시세·거래 / 관리비 / 단지 정보 / 주변환경 / 학군 / 3D
 */
export default function NearbySchoolDevPage() {
  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f8fafc_0%,#eef6f4_40%,#f8fafc_100%)]">
      <NearbySchoolMapPilot />
    </main>
  );
}
