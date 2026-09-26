import type { Metadata } from "next";
import { MapSearchPage } from "@/components/map/MapSearchPage";

/** 첫 화면은 지도 — 집랩의 핵심 (시장 홈은 /market) */
export const metadata: Metadata = {
  title: "집랩 - 지도로 보는 아파트 실거래·3D 단지",
  description: "지도에서 단지별 최근 실거래 가격을 한눈에 비교하고, 서울 전체를 3D로 둘러보세요.",
};

export default function Page() {
  return <MapSearchPage />;
}
