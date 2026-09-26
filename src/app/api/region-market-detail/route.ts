import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { parseRegionScope } from "@/lib/region/region-scope";
import { readRegionMarketDetail } from "@/lib/region/region-market-detail";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { scope, error } = parseRegionScope(request.nextUrl.searchParams);
  if (!scope) {
    return NextResponse.json({ error }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
  try {
    const data = await readRegionMarketDetail(db, scope.lawdCd, scope.dong);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
