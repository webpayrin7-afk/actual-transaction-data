import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { publishedComplexPosition, type LaunchAreaBand } from "@/lib/region-ranking/query";
import { SMALL_DONG_COHORT_MAX } from "@/lib/region-ranking/score";

export const dynamic = "force-dynamic";

const BANDS = new Set(["ALL", "59", "84", "114"]);

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
    smallCohort: scope === "dong" && (slot.regionTotal ?? 0) > 0 && (slot.regionTotal ?? 0) <= SMALL_DONG_COHORT_MAX,
  };
}

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBand = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }
  if (areaBand && !BANDS.has(areaBand)) {
    return NextResponse.json({ error: "area_band가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    const data = await publishedComplexPosition(db, {
      complexId,
      areaBand: areaBand ? (areaBand as LaunchAreaBand) : null,
    });
    if (!data.found) {
      return NextResponse.json({
        status: "unavailable",
        complex_id: complexId,
        apt_name: null,
        dong: null,
        all: null,
        area: null,
      });
    }
    const byBand = new Map(data.positions.map((item) => [item.areaBand, item]));
    const all = byBand.get("ALL");
    const selected = areaBand && areaBand !== "ALL" ? byBand.get(areaBand as LaunchAreaBand) : undefined;
    const allGu = place(all?.gu as Slot | undefined, "gu");
    const allDong = place(all?.dong as Slot | undefined, "dong");
    const ranked = allGu.status === "ranked" || allDong.status === "ranked"
      || (selected != null && (place(selected.gu as Slot, "gu").status === "ranked" || place(selected.dong as Slot, "dong").status === "ranked"));
    return NextResponse.json({
      status: ranked ? "ok" : "unavailable",
      complex_id: data.complexId,
      apt_name: data.aptName,
      dong: data.dongName,
      transactionAsOf: allGu.transactionAsOf ?? allDong.transactionAsOf ?? null,
      rankingVersion: allGu.rankingVersion ?? allDong.rankingVersion ?? null,
      all: {
        gu: allGu,
        dong: allDong,
      },
      area: selected
        ? {
          rankingType: areaBand,
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
