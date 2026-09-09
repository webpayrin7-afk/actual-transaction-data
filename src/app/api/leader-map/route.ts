import { NextRequest, NextResponse } from "next/server";
import { getSeoulLeaderMap } from "@/lib/leader-map/compute";

/** 대장 지도는 초 단위 실시간이 아님 — 30분 서버 캐시 + CDN */
export const revalidate = 1800;
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const region = request.nextUrl.searchParams.get("region")?.trim() || "seoul";
  if (region !== "seoul") {
    return NextResponse.json(
      { error: "이번 버전은 서울만 지원합니다." },
      { status: 400 },
    );
  }

  try {
    const data = await getSeoulLeaderMap();
    const gu = request.nextUrl.searchParams.get("gu")?.trim() ?? "";
    if (!gu) {
      return NextResponse.json(data, {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      });
    }

    const row = data.gus.find((g) => g.name === gu || g.slug === gu);
    if (!row) {
      return NextResponse.json(
        { error: "해당 구를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        metro: data.metro,
        source: data.source,
        asOfDate: data.asOfDate,
        window: data.window,
        computedAt: data.computedAt,
        gu: row,
        dongs: data.dongsByGu[row.name] ?? [],
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    console.error("[leader-map]", error);
    return NextResponse.json(
      { error: "대장 아파트 지도를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
