import type { Metadata } from "next";
import { MapSearchPage } from "@/components/map/MapSearchPage";

/** 첫 화면은 지도 — 집랩의 핵심 (시장 홈은 /market) */
export const metadata: Metadata = {
  title: "집랩 - 지도로 보는 아파트 실거래·3D 단지",
  description: "지도에서 단지별 최근 실거래 가격을 한눈에 비교하고, 서울 전체를 3D로 둘러보세요.",
};

export default function Page() {
  // 브이월드 위성영상 키 — 도메인(서비스 URL)에 묶인 브라우저용 키라 화면에 실려도 된다
  return <MapSearchPage satelliteKey={process.env.VWORLD_WEB_KEY?.trim() || null} />;
}
