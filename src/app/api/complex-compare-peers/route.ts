import { NextRequest, NextResponse } from "next/server";
import { selectComparePeers } from "@/lib/complex-detail/select-compare-peers";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Auto nearby/similar peers for complex compare (max 2).
 * Query: aptName, gu, dong?, areaCenter?, buildYear?, householdCount?
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const aptName = sp.get("aptName")?.trim() ?? "";
  const gu = sp.get("gu")?.trim() ?? "";
  const dong = sp.get("dong")?.trim() ?? "";
  if (!aptName || !gu) {
    return NextResponse.json(
      { peers: [], reason: "aptName and gu are required" },
      { status: 400 },
    );
  }

  const areaCenterRaw = sp.get("areaCenter");
  const buildYearRaw = sp.get("buildYear");
  const householdRaw = sp.get("householdCount");
  const areaCenter =
    areaCenterRaw != null && areaCenterRaw !== ""
      ? Number(areaCenterRaw)
      : null;
  const buildYear =
    buildYearRaw != null && buildYearRaw !== ""
      ? Number(buildYearRaw)
      : null;
  const householdCount =
    householdRaw != null && householdRaw !== ""
      ? Number(householdRaw)
      : null;

  try {
    const peers = await selectComparePeers({
      aptName,
      gu,
      dong,
      targetExclusiveCenter:
        areaCenter != null && Number.isFinite(areaCenter) ? areaCenter : null,
      buildYear:
        buildYear != null && Number.isFinite(buildYear) ? buildYear : null,
      householdCount:
        householdCount != null && Number.isFinite(householdCount)
          ? householdCount
          : null,
      limit: 2,
    });
    const res = NextResponse.json({ peers });
    res.headers.set(
      "Cache-Control",
      "private, max-age=120, stale-while-revalidate=600",
    );
    return res;
  } catch (error) {
    console.error("[complex-compare-peers]", error);
    return NextResponse.json(
      { peers: [], reason: "peer selection failed" },
      { status: 500 },
    );
  }
}
