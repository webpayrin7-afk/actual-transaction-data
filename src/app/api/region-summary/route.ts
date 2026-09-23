import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRegionAptSummary } from "@/lib/region/region-summary";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const lawdCd = request.nextUrl.searchParams.get("lawd_cd")?.trim() ?? "";
  if (!/^[0-9]{5}$/.test(lawdCd)) {
    return NextResponse.json({ error: "lawd_cd가 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
  try {
    const data = await readRegionAptSummary(db, lawdCd);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
