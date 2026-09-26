import type { MarketHomeResponse } from "@/lib/market/home";

/**
 * 시장 홈 데이터 (브라우저) — /market 과 지도 첫 화면 '오늘의 시장 브리핑'이 같은 React Query 키로 나눠 쓴다.
 * 한쪽에서 불러오면 다른 쪽은 다시 부르지 않는다 (스냅샷 읽기 · CDN 60초).
 */
export const MARKET_HOME_QUERY_KEY = ["market-home"] as const;
export const MARKET_HOME_STALE_MS = 5 * 60 * 1000;

export async function fetchMarketHome(): Promise<MarketHomeResponse> {
  const res = await fetch("/api/market-home");
  if (!res.ok) throw new Error("시장 데이터를 불러오지 못했습니다.");
  return res.json();
}
