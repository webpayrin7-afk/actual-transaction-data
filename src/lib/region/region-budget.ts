/**
 * 예산으로 찾는 단지 (read-only).
 * 평형대별 Ranking V4 보드에서 최근 1년 거래가 중앙값이 예산 이하인 단지를 V4 순서로 고른다.
 */
import type { RankingAreaBandV3, RankingReader } from "@/lib/region-ranking/query";
import { readRankingV4Board } from "@/lib/region-ranking/ranking-v4";

export const BUDGET_BANDS: Array<{ key: RankingAreaBandV3; label: string }> = [
  { key: "20", label: "20평대" },
  { key: "30", label: "30평대" },
  { key: "40", label: "40평대" },
  { key: "50", label: "50평대" },
];

const ITEMS_PER_BAND = 8;

export type RegionBudgetItem = {
  complexId: string;
  name: string | null;
  dong: string | null;
  medianDealAmount: number;
  tradeCount: number;
};

export type RegionBudgetResult = {
  status: "ok";
  lawdCd: string;
  budget: number;
  transactionAsOf: string | null;
  bands: Array<{
    key: RankingAreaBandV3;
    label: string;
    matched: number;
    total: number;
    items: RegionBudgetItem[];
  }>;
};

export async function readRegionBudget(
  db: RankingReader,
  lawdCd: string,
  budget: number,
): Promise<RegionBudgetResult> {
  const boards = await Promise.all(
    BUDGET_BANDS.map((band) => readRankingV4Board(db, { regionCode: lawdCd, areaBand: band.key })),
  );
  return {
    status: "ok",
    lawdCd,
    budget,
    transactionAsOf: boards.find((b) => b.transactionAsOf)?.transactionAsOf ?? null,
    bands: BUDGET_BANDS.map((band, index) => {
      const rows = boards[index]?.rows ?? [];
      const matched = rows.filter(
        (row) => row.metrics.medianDealAmount != null && row.metrics.medianDealAmount <= budget,
      );
      return {
        key: band.key,
        label: band.label,
        matched: matched.length,
        total: rows.length,
        items: matched.slice(0, ITEMS_PER_BAND).map((row) => ({
          complexId: row.complexId,
          name: row.name,
          dong: row.dong,
          medianDealAmount: row.metrics.medianDealAmount!,
          tradeCount: row.metrics.tradeCount,
        })),
      };
    }),
  };
}
