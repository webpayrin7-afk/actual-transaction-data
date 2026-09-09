import { NextRequest, NextResponse } from "next/server";
import { getRegion } from "@/lib/constants/regions";
import { getRegionDaily } from "@/lib/molit/service";

export const revalidate = 60;
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const yearMonth = request.nextUrl.searchParams.get("yearMonth")?.trim() ?? "";
  const date = request.nextUrl.searchParams.get("date")?.trim() ?? "";

  if (!regionSlug || !getRegion(regionSlug)) {
    return NextResponse.json({ error: "유효한 region이 필요합니다." }, { status: 400 });
  }

  try {
    const data = await getRegionDaily({
      regionSlug,
      yearMonth: yearMonth || undefined,
      date: date || undefined,
    });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "일별 신고가를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
