import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  publishedComplexPosition,
  type RankingAreaBandV3,
} from "@/lib/region-ranking/query";
import { SMALL_DONG_COHORT_MAX } from "@/lib/region-ranking/score";
import { decadeKeyFromRankingBand } from "@/lib/region-ranking/ranking-v3";
import { decadeCohortByKey, decadeCohortForLabel } from "@/lib/region-ranking/price-position-v22";
import { resolveSelectedMarketPyeongLabel } from "@/lib/region-ranking/price-position-read";

export const dynamic = "force-dynamic";

const BANDS = new Set([
  "ALL",
  "59",
  "84",
  "114",
  "10",
  "20",
  "30",
  "40",
  "50",
  "60",
  "70",
  "80",
  "90",
  "100",
]);

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
  if (!metrics) return null;
  if (!("coverage_status" in metrics) && !("price_availability" in metrics)) return null;
  return {
    expected_bands: metrics.expected_bands ?? null,
    valid_bands: metrics.valid_bands ?? null,
    expected_band_count: metrics.expected_band_count ?? null,
    valid_band_count: metrics.valid_band_count ?? null,
    coverage_completeness: metrics.coverage_completeness ?? null,
    coverage_status: metrics.coverage_status ?? null,
    price_availability: metrics.price_availability ?? null,
    available_weight_share: metrics.available_weight_share ?? null,
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
    smallCohort: scope === "dong" && (slot.regionTotal ?? 0) > 0 && (slot.regionTotal ?? 0) <= SMALL_DONG_COHORT_MAX,
  };
}

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBandRaw = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  const exclusiveRaw = request.nextUrl.searchParams.get("exclusive_area")?.trim() ?? "";
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }
  if (areaBandRaw && !BANDS.has(areaBandRaw)) {
    return NextResponse.json({ error: "area_band가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    let selectedMarketPyeongLabel: number | null = null;
    let regionPyeongDecade: string | null = null;
    let storageBand: RankingAreaBandV3 | null = areaBandRaw ? (areaBandRaw as RankingAreaBandV3) : null;

    if (exclusiveRaw) {
      const exclusiveArea = Number(exclusiveRaw);
      if (Number.isFinite(exclusiveArea)) {
        const resolved = await resolveSelectedMarketPyeongLabel(db, { complexId, exclusiveArea });
        if (resolved.kind === "exact") {
          selectedMarketPyeongLabel = resolved.marketPyeongLabel;
          const cohort = decadeCohortForLabel(resolved.marketPyeongLabel);
          if (cohort) {
            regionPyeongDecade = cohort.label;
            if (!storageBand || storageBand === "ALL") {
              storageBand = cohort.key as RankingAreaBandV3;
            } else {
              const mapped = decadeKeyFromRankingBand(storageBand);
              if (mapped !== "ALL" && mapped !== cohort.key) {
                return NextResponse.json({ error: "area_band가 선택 평형과 일치하지 않습니다." }, { status: 400 });
              }
              storageBand = cohort.key as RankingAreaBandV3;
            }
          }
        }
      }
    } else if (storageBand && storageBand !== "ALL") {
      const mapped = decadeKeyFromRankingBand(storageBand);
      if (mapped && mapped !== "ALL") {
        storageBand = mapped;
        regionPyeongDecade = decadeCohortByKey(mapped)?.label ?? null;
      }
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
        selectedMarketPyeongLabel: null,
        regionPyeongDecade: null,
      });
    }
    const byBand = new Map(data.positions.map((item) => [item.areaBand, item]));
    const all = byBand.get("ALL");
    const selected = storageBand && storageBand !== "ALL" ? byBand.get(storageBand) : undefined;
    const allGu = place(all?.gu as Slot | undefined, "gu");
    const allDong = place(all?.dong as Slot | undefined, "dong");
    const ranked =
      allGu.status === "ranked" ||
      allDong.status === "ranked" ||
      (selected != null &&
        (place(selected.gu as Slot, "gu").status === "ranked" ||
          place(selected.dong as Slot, "dong").status === "ranked"));
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
            regionPyeongDecade,
            selectedMarketPyeongLabel,
            gu: place(selected.gu as Slot, "gu"),
            dong: place(selected.dong as Slot, "dong"),
          }
        : null,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "단지 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}
