import { NextResponse } from "next/server";
import { getHousingHeadlines } from "@/lib/market/naver-news";

/** 뉴스 검색 캐시와 같은 주기 (naver-news HEADLINES_REVALIDATE_SECONDS) */
export const revalidate = 900;

export async function GET() {
  try {
    const data = await getHousingHeadlines();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control":
          data.status === "ok" ? "public, s-maxage=900, stale-while-revalidate=1800" : "no-store",
      },
    });
  } catch (error) {
    console.error("[market-headlines]", error);
    return NextResponse.json({ error: "뉴스를 불러오지 못했습니다." }, { status: 502 });
  }
}
