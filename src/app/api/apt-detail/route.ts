import { NextRequest, NextResponse } from "next/server";
import { getAptDetail } from "@/lib/molit/apt";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const gu = request.nextUrl.searchParams.get("gu")?.trim() ?? "";
  const monthsRaw = Number(request.nextUrl.searchParams.get("months") ?? "36");
  const boundRaw = request.nextUrl.searchParams.get("bound")?.trim() ?? "";
  const boundMonths = boundRaw === "1" || boundRaw === "true";

  if (!aptName || !regionSlug) {
    return NextResponse.json(
      { error: "aptName과 region이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const months = Number.isFinite(monthsRaw)
      ? Math.min(Math.max(monthsRaw, 6), 120)
      : 36;
    const detail = await getAptDetail({
      aptName,
      regionSlug,
      months,
      gu: gu || undefined,
      boundMonths,
    });
    if (!detail) {
      return NextResponse.json(
        { error: "단지를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const res = NextResponse.json(detail);
    // 사용자별 데이터가 아니라(쿠키·세션 미사용) 쿼리(aptName·region·gu·months·v)별로
    // CDN에 캐시 — 대단지(헬리오 1.6만 건)를 인스턴스마다 다시 만들지 않게.
    // 실거래 동기화는 하루 1회라 s-maxage 10분 + SWR 1일이면 충분. 브라우저 max-age는 기존 유지.
    res.headers.set(
      "Cache-Control",
      detail.partial
        ? "public, max-age=120, s-maxage=120, stale-while-revalidate=600"
        : "public, max-age=600, s-maxage=600, stale-while-revalidate=86400",
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
