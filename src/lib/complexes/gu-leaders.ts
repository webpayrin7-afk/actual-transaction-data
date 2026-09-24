/**
 * 단지 조회 첫 페이지 — 구별 대장 단지.
 * 시·도 안 시·군·구마다 종합 랭킹(ranking v4, 전체 면적, 12개월) 1위 단지. 지도 왕관 1위와 같다.
 * 평당 중위가 높은 구부터. 읽기 전용, 30분 캐시.
 */
import type { Client } from "@libsql/client";
import { ALL_REGIONS, type Metro } from "@/lib/constants/regions";
import { aptDetailHref } from "@/lib/molit/apt-client";
import { readRankingV4Board } from "@/lib/region-ranking/ranking-v4";

const CACHE_TTL_MS = 30 * 60 * 1000;

export type GuLeader = {
  lawdCd: string;
  guName: string;
  complexId: string;
  aptName: string;
  dong: string | null;
  households: number;
  buildYear: number | null;
  medianDealAmount: number | null;
  /** 전용 평당 중위가 (만원) */
  medianPerPyeong: number;
  tradeCount: number;
  /** 그 구 랭킹 대상 단지 수 */
  regionTotal: number;
  href: string;
};

export type GuLeadersResponse = { metro: string; transactionAsOf: string | null; items: GuLeader[] };

const cache = new Map<string, { at: number; value: GuLeadersResponse }>();

export async function readGuLeaders(db: Client, metro: Metro): Promise<GuLeadersResponse> {
  const hit = cache.get(metro);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const districts = ALL_REGIONS.filter((r) => r.metro === metro).flatMap((r) =>
    r.districts.map((d) => ({ region: r, code: d.code, name: d.name })),
  );
  let asOf: string | null = null;
  const items: GuLeader[] = [];
  // 동시 8개씩 — 시·도 하나에 구가 40개 넘을 수 있다.
  for (let i = 0; i < districts.length; i += 8) {
    const boards = await Promise.all(
      districts.slice(i, i + 8).map((d) =>
        readRankingV4Board(db, { regionCode: d.code, areaBand: "ALL" })
          .then((b) => ({ d, b }))
          .catch(() => null),
      ),
    );
    for (const x of boards) {
      if (!x) continue;
      const top = x.b.rows.find((r) => r.rank === 1);
      if (!top || !top.name) continue;
      asOf = asOf ?? x.b.transactionAsOf;
      const guName = x.d.region.districts.length > 1 ? `${x.d.region.name} ${x.d.name}` : x.d.name;
      items.push({
        lawdCd: x.d.code,
        guName,
        complexId: top.complexId,
        aptName: top.name,
        dong: top.dong,
        households: top.metrics.households,
        buildYear: top.buildYear,
        medianDealAmount: top.metrics.medianDealAmount,
        medianPerPyeong: Math.round(top.metrics.medianPricePerSqm * 3.3058),
        tradeCount: top.metrics.tradeCount,
        regionTotal: top.regionTotal,
        href: aptDetailHref(top.name, x.d.region.slug, x.d.region.districts.length > 1 ? x.d.name : undefined),
      });
    }
  }
  items.sort((a, b) => b.medianPerPyeong - a.medianPerPyeong);
  const value = { metro, transactionAsOf: asOf, items };
  cache.set(metro, { at: Date.now(), value });
  return value;
}
