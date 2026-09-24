import type { Metadata } from "next";
import { MapSearchPage } from "@/components/map/MapSearchPage";

export const metadata: Metadata = {
  title: "지도로 찾기 - 집랩",
  description: "지도에서 단지별 최근 실거래 가격을 한눈에 비교하세요.",
};

export default function MapPage() {
  return <MapSearchPage />;
}
