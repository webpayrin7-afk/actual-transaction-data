import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  publishedComplexPosition,
  type RankingAreaBandV3,
} from "@/lib/region-ranking/query";
import { SMALL_DONG_COHORT_MAX } from "@/lib/region-ranking/score";
import {
  DECADE_KEYS_V3,
  decadeCohortByKey,
  decadeCohortForLabel,
  parseSelectedMarketPyeongLabel,
} from "@/lib/region-ranking/ranking-v3";

export const dynamic = "force-dynamic";

// 공개 순위(일 1회 갱신)라 CDN에 1시간 캐시. 쿼리스트링이 캐시 키. 오류(500)는 캐시 안 함.
const CACHE_OK = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" };

type Slot = {
  published?: boolean;
  status: string;
  rank?: number;
  regionTotal?: number;
  confidenceBucket?: string | null;
  transactionAsOf?: string;
  rankingVersion?: string;
  publicMetrics?: Record<string, unknown>;
};

function coverageOf(metrics: Record<string, unknown> | undefined) {
  if (!metrics || !("coverage_status" in metrics)) return null;
  return {
    expected_bands: metrics.expected_bands ?? null,
    valid_bands: metrics.valid_bands ?? null,
    expected_band_count: metrics.expected_band_count ?? null,
    valid_band_count: metrics.valid_band_count ?? null,
    coverage_completeness: metrics.coverage_completeness ?? null,
    coverage_status: metrics.coverage_status ?? null,
    single_product_band: metrics.single_product_band === true,
  };
}

function place(slot: Slot | undefined, scope: "gu" | "dong") {
  if (!slot || slot.status !== "ranked" || slot.rank == null) {
    return {
      status: "unavailable" as const,
      rank: null,
      total: null,
      confidence: null,
      coverage: null,
      transactionAsOf: slot?.transactionAsOf ?? null,
      rankingVersion: slot?.rankingVersion ?? null,
      smallCohort: false,
    };
  }
  return {
    status: "ranked" as const,
    rank: slot.rank,
    total: slot.regionTotal ?? null,
    confidence: slot.confidenceBucket ?? null,
    coverage: coverageOf(slot.publicMetrics),
    transactionAsOf: slot.transactionAsOf ?? null,
    rankingVersion: slot.rankingVersion ?? null,
    smallCohort:
      scope === "dong" &&
      (slot.regionTotal ?? 0) > 0 &&
      (slot.regionTotal ?? 0) <= SMALL_DONG_COHORT_MAX,
  };
}

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBandRaw = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  const marketPyeongLabel = parseSelectedMarketPyeongLabel(
    request.nextUrl.searchParams.get("market_pyeong_label"),
  );
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }
  if (areaBandRaw && areaBandRaw !== "ALL" && !DECADE_KEYS_V3.has(areaBandRaw)) {
    return NextResponse.json({ error: "area_band가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    const selectedMarketPyeongLabel = marketPyeongLabel;
    let regionPyeongDecade: string | null = null;
    let storageBand: RankingAreaBandV3 | null = null;

    if (selectedMarketPyeongLabel != null) {
      const cohort = decadeCohortForLabel(selectedMarketPyeongLabel);
      if (cohort) {
        regionPyeongDecade = cohort.label;
        storageBand = cohort.key;
      }
    } else if (areaBandRaw && DECADE_KEYS_V3.has(areaBandRaw)) {
      storageBand = areaBandRaw as RankingAreaBandV3;
      regionPyeongDecade = decadeCohortByKey(areaBandRaw)?.label ?? null;
    }

    const data = await publishedComplexPosition(db, {
      complexId,
      areaBand: storageBand,
    });
    if (!data.found) {
      return NextResponse.json({
        status: "unavailable",
        complex_id: complexId,
        apt_name: null,
        dong: null,
        all: null,
        area: null,
        selectedMarketPyeongLabel,
        regionPyeongDecade,
      }, { headers: CACHE_OK });
    }
    const byBand = new Map(data.positions.map((item) => [item.areaBand, item]));
    const all = byBand.get("ALL");
    const selected =
      storageBand && storageBand !== "ALL" ? byBand.get(storageBand) : undefined;
    const allGu = place(all?.gu as Slot | undefined, "gu");
    const allDong = place(all?.dong as Slot | undefined, "dong");
    const selectedGu = selected ? place(selected.gu as Slot, "gu") : null;
    const selectedDong = selected ? place(selected.dong as Slot, "dong") : null;
    const ranked =
      allGu.status === "ranked" ||
      allDong.status === "ranked" ||
      selectedGu?.status === "ranked" ||
      selectedDong?.status === "ranked";
    return NextResponse.json({
      status: ranked ? "ok" : "unavailable",
      complex_id: data.complexId,
      apt_name: data.aptName,
      dong: data.dongName,
      transactionAsOf: allGu.transactionAsOf ?? allDong.transactionAsOf ?? null,
      rankingVersion: allGu.rankingVersion ?? allDong.rankingVersion ?? null,
      selectedMarketPyeongLabel,
      regionPyeongDecade,
      all: {
        gu: allGu,
        dong: allDong,
      },
      area: selected
        ? {
            rankingType: storageBand,
            selectedMarketPyeongLabel,
            regionPyeongDecade,
            gu: selectedGu,
            dong: selectedDong,
          }
        : null,
    }, { headers: CACHE_OK });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "단지 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}
