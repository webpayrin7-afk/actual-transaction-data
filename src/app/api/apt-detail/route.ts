import { NextRequest, NextResponse } from "next/server";
import { getAptDetail } from "@/lib/molit/apt";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const monthsRaw = Number(request.nextUrl.searchParams.get("months") ?? "18");

  if (!aptName || !regionSlug) {
    return NextResponse.json(
      { error: "aptName과 region이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const months = Number.isFinite(monthsRaw)
      ? Math.min(Math.max(monthsRaw, 6), 120)
      : 18;
    const detail = await getAptDetail({
      aptName,
      regionSlug,
      months,
    });
    if (!detail) {
      return NextResponse.json(
        { error: "단지를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const res = NextResponse.json(detail);
    // 동일 단지 재방문 시 브라우저/엣지 캐시로 체감 속도 개선
    res.headers.set(
      "Cache-Control",
      detail.partial
        ? "private, max-age=60, stale-while-revalidate=300"
        : "private, max-age=300, stale-while-revalidate=1800",
    );
    return res;
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "단지 상세를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
