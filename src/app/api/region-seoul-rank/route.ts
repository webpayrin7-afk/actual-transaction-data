import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readSeoulGuPriceRanks } from "@/lib/region/region-price-index";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" };

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
    const ranks = await readSeoulGuPriceRanks(db);
    const gu = ranks?.gus.find((g) => g.lawdCd === lawdCd);
    if (!ranks || !gu) {
      return NextResponse.json({ status: "unavailable" }, { headers: CACHE_HEADERS });
    }
    return NextResponse.json(
      {
        status: "ok",
        yearMonth: ranks.yearMonth,
        total: ranks.total,
        lawdCd: gu.lawdCd,
        name: gu.name,
        pyeongPrice: gu.pyeongPrice,
        change1y: gu.change1y,
        priceRank: gu.priceRank,
        change1yRank: gu.change1yRank,
        gus: ranks.gus,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
