import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { resolveSelectedAreaBand, type RegionalAreaBandId } from "@/lib/region-ranking/area-band";
import {
  PRICE_POSITION_PUBLIC_AS_OF,
  PRICE_POSITION_PUBLIC_VERSION,
  readComplexPricePosition,
} from "@/lib/region-ranking/price-position-read";
import { pricePositionStorageBand } from "@/lib/region-ranking/price-position-v23";
import { parseMarketPyeongLabelParam } from "@/lib/region-ranking/public";
import { decadeCohortByKey, decadeCohortForLabel } from "@/lib/region-ranking/ranking-v3";

export const dynamic = "force-dynamic";

const LEGACY_BANDS = new Set<RegionalAreaBandId>(["59", "84", "114"]);

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

function resolveDecadeKey(params: {
  marketPyeongLabel: number | null;
  areaBandRaw: string;
  exclusiveArea: number | null;
}): string | null {
  if (params.marketPyeongLabel != null) {
    return decadeCohortForLabel(params.marketPyeongLabel)?.key ?? null;
  }
  if (params.areaBandRaw) {
    return pricePositionStorageBand(params.areaBandRaw);
  }
  if (params.exclusiveArea != null) {
    const legacy = resolveSelectedAreaBand(params.exclusiveArea);
    return legacy ? pricePositionStorageBand(legacy) : null;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBandRaw = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  const exclusiveRaw = request.nextUrl.searchParams.get("exclusive_area")?.trim() ?? "";
  const marketPyeongLabel = parseMarketPyeongLabelParam(
    request.nextUrl.searchParams.get("market_pyeong_label"),
  );
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }

  let exclusiveArea: number | null = null;
  if (exclusiveRaw) {
    exclusiveArea = Number(exclusiveRaw);
    if (!Number.isFinite(exclusiveArea)) return unsupported(complexId, null);
  } else if (!areaBandRaw && marketPyeongLabel == null) {
    return NextResponse.json({ error: "area_band가 필요합니다." }, { status: 400 });
  }

  if (areaBandRaw && !LEGACY_BANDS.has(areaBandRaw as RegionalAreaBandId) && !decadeCohortByKey(areaBandRaw)) {
    return unsupported(complexId, exclusiveArea);
  }

  const decadeKey = resolveDecadeKey({ marketPyeongLabel, areaBandRaw, exclusiveArea });
  if (!decadeKey || !decadeCohortByKey(decadeKey)) {
    return unsupported(complexId, exclusiveArea);
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "시세 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    const found = await readComplexPricePosition(db, {
      complexId,
      areaBand: decadeKey,
      exclusiveArea,
      marketPyeongLabel,
    });
    if (found.kind === "missing" || found.kind === "outside-seoul") {
      return NextResponse.json({
        status: "unavailable",
        version: PRICE_POSITION_PUBLIC_VERSION,
        complexId,
        areaBand: decadeKey,
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
