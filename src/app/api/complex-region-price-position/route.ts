import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { resolveSelectedAreaBand, type RegionalAreaBandId } from "@/lib/region-ranking/area-band";
import {
  PRICE_POSITION_PUBLIC_AS_OF,
  PRICE_POSITION_PUBLIC_VERSION,
  readComplexPricePosition,
} from "@/lib/region-ranking/price-position-read";

export const dynamic = "force-dynamic";

const BANDS = new Set<RegionalAreaBandId>(["59", "84", "114"]);

function unsupported(complexId: string, exclusiveArea: number | null) {
  return NextResponse.json({
    status: "PRICE_COMPARE_UNSUPPORTED_AREA",
    version: PRICE_POSITION_PUBLIC_VERSION,
    complexId,
    areaBand: null,
    exclusiveArea,
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
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }

  let areaBand: RegionalAreaBandId | null = null;
  let exclusiveArea: number | null = null;
  if (exclusiveRaw) {
    exclusiveArea = Number(exclusiveRaw);
    const resolved = resolveSelectedAreaBand(exclusiveArea);
    if (!resolved) return unsupported(complexId, Number.isFinite(exclusiveArea) ? exclusiveArea : null);
    if (areaBandRaw && areaBandRaw !== resolved) return unsupported(complexId, exclusiveArea);
    areaBand = resolved;
  } else if (areaBandRaw) {
    if (!BANDS.has(areaBandRaw as RegionalAreaBandId)) return unsupported(complexId, null);
    areaBand = areaBandRaw as RegionalAreaBandId;
  } else {
    return NextResponse.json({ error: "area_band가 필요합니다." }, { status: 400 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "시세 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    const found = await readComplexPricePosition(db, { complexId, areaBand });
    if (found.kind === "missing" || found.kind === "outside-seoul") {
      return NextResponse.json({
        status: "unavailable",
        version: PRICE_POSITION_PUBLIC_VERSION,
        complexId,
        areaBand,
        transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
        referenceMonth: null,
        priceLevel: [],
        trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
      });
    }
    return NextResponse.json(found.body);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "지역 내 가격 위치를 불러오지 못했습니다." }, { status: 500 });
  }
}
