import { NextResponse } from "next/server";
import { getPolicyNews } from "@/lib/market/policy-news";

/** 부처 RSS 캐시와 같은 주기 (policy-news POLICY_NEWS_REVALIDATE_SECONDS) */
export const revalidate = 1800;

export async function GET() {
  try {
    const data = await getPolicyNews();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("[market-news]", error);
    return NextResponse.json(
      { error: "정책 발표를 불러오지 못했습니다." },
      { status: 502 },
    );
  }
}
