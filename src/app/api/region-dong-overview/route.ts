import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { parseRegionScope } from "@/lib/region/region-scope";
import { readRegionDongOverview } from "@/lib/region/region-dong-overview";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { scope, error } = parseRegionScope(request.nextUrl.searchParams);
  if (!scope || !scope.dong) {
    return NextResponse.json({ error: error ?? "dong이 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
  try {
    const data = await readRegionDongOverview(db, scope.lawdCd, scope.dong);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
