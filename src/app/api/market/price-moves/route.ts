import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  PRICE_MOVES_PERIODS,
  readPriceMoves,
  type PriceMovesArea,
  type PriceMovesPeriod,
  type PriceMovesSort,
} from "@/lib/market/price-moves";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const AREAS: PriceMovesArea[] = ["all", "small", "mid", "large"];
const SORTS: PriceMovesSort[] = ["amount", "pct", "recent"];

/** 시장 > 신고가 · 하락 거래 — 기간·지역·면적별 목록 (market_price_moves 읽기 전용) */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const kind = sp.get("kind") === "drop" ? "drop" : "singoga";
  const periodParam = sp.get("period") ?? "7d";
  const period: PriceMovesPeriod = periodParam in PRICE_MOVES_PERIODS ? (periodParam as PriceMovesPeriod) : "7d";
  const areaParam = sp.get("area") as PriceMovesArea | null;
  const area: PriceMovesArea = areaParam && AREAS.includes(areaParam) ? areaParam : "all";
  const sortParam = sp.get("sort") as PriceMovesSort | null;
  const sort: PriceMovesSort = sortParam && SORTS.includes(sortParam) ? sortParam : "amount";
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));

  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readPriceMoves(db, {
      kind,
      period,
      region: sp.get("region"),
      sido: sp.get("sido"),
      area,
      sort,
      offset,
      limit,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800" },
    });
  } catch (error) {
    console.error("[price-moves]", error);
    return NextResponse.json({ error: "신고가·하락 거래를 불러오지 못했습니다." }, { status: 500 });
  }
}
