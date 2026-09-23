import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRegionBudget } from "@/lib/region/region-budget";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const lawdCd = request.nextUrl.searchParams.get("lawd_cd")?.trim() ?? "";
  const budget = Number(request.nextUrl.searchParams.get("budget") ?? "");
  if (!/^[0-9]{5}$/.test(lawdCd) || !Number.isFinite(budget) || budget <= 0 || budget > 10_000_000) {
    return NextResponse.json({ error: "lawd_cd와 budget(만원)이 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable" }, { status: 503 });
  try {
    const data = await readRegionBudget(db, lawdCd, Math.round(budget));
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
