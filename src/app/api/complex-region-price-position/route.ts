import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  PRICE_POSITION_PUBLIC_AS_OF,
  PRICE_POSITION_PUBLIC_VERSION,
  readComplexPricePosition,
  resolveSelectedMarketPyeongLabel,
} from "@/lib/region-ranking/price-position-read";
import { resolveV22PricePositionRequest } from "@/lib/region-ranking/price-position-v22";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function unsupported(complexId: string, exclusiveArea: number | null) {
  return json({
    status: "PRICE_COMPARE_UNSUPPORTED_AREA",
    version: PRICE_POSITION_PUBLIC_VERSION,
    snapshotId: null,
    complexId,
    areaBand: null,
    exclusiveArea,
    selectedMarketPyeongLabel: null,
    regionPyeongDecade: null,
    transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
    referenceMonth: null,
    priceLevel: [],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
    maxAvailableValue: { priceLevel: null, trends: { "6M": null, "1Y": null, "2Y": null, "5Y": null } },
  });
}

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBandRaw = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  const exclusiveRaw = request.nextUrl.searchParams.get("exclusive_area")?.trim() ?? "";
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return json({ error: "complex_id가 필요합니다." }, 400);
  }
  return getDecadeCohort(complexId, areaBandRaw, exclusiveRaw);
}

async function getDecadeCohort(complexId: string, areaBandRaw: string, exclusiveRaw: string) {
  let exclusiveArea: number | null = null;
  if (exclusiveRaw) {
    exclusiveArea = Number(exclusiveRaw);
    if (!Number.isFinite(exclusiveArea)) return unsupported(complexId, null);
  } else if (!areaBandRaw) {
    return json({ error: "area_band가 필요합니다." }, 400);
  }

  const db = getDb();
  if (!db) {
    return json({ error: "시세 저장소를 사용할 수 없습니다." }, 500);
  }
  try {
    const label = exclusiveArea == null ? null : await resolveSelectedMarketPyeongLabel(db, { complexId, exclusiveArea });
    const resolved = resolveV22PricePositionRequest({ areaBandRaw, exclusiveArea, label });
    if (!resolved.ok) {
      if (resolved.reason === "AREA_BAND_REQUIRED" && !exclusiveRaw) {
        return json({ error: "area_band가 필요합니다." }, 400);
      }
      return unsupported(complexId, exclusiveArea);
    }
    const found = await readComplexPricePosition(db, {
      complexId,
      areaBand: resolved.decadeKey,
      exclusiveArea: resolved.exclusiveArea,
    });
    if (found.kind === "missing" || found.kind === "outside-seoul") {
      return json({
        status: "unavailable",
        version: PRICE_POSITION_PUBLIC_VERSION,
        snapshotId: null,
        complexId,
        areaBand: resolved.decadeKey,
        selectedMarketPyeongLabel: null,
        regionPyeongDecade: resolved.regionPyeongDecade,
        transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
        referenceMonth: null,
        priceLevel: [],
        trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
      });
    }
    return json(found.body);
  } catch (error) {
    console.error(error);
    return json({ error: "지역 내 가격 위치를 불러오지 못했습니다." }, 500);
  }
}
