import { NextRequest, NextResponse } from "next/server";
import { getAptDetail } from "@/lib/molit/apt";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const months = Number(request.nextUrl.searchParams.get("months") ?? "36");

  if (!aptName || !regionSlug) {
    return NextResponse.json(
      { error: "aptName과 region이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const detail = await getAptDetail({
      aptName,
      regionSlug,
      months: Number.isFinite(months) ? Math.min(Math.max(months, 6), 60) : 36,
    });
    if (!detail) {
      return NextResponse.json(
        { error: "단지를 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "단지 상세를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
