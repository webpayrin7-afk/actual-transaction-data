import { NextRequest, NextResponse } from "next/server";
import { getRegion } from "@/lib/constants/regions";
import { getRegionBrowse } from "@/lib/molit/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const dong = request.nextUrl.searchParams.get("dong")?.trim() ?? "";
  const gu = request.nextUrl.searchParams.get("gu")?.trim() ?? "";

  if (!regionSlug || !getRegion(regionSlug)) {
    return NextResponse.json({ error: "유효한 region이 필요합니다." }, { status: 400 });
  }

  try {
    const data = await getRegionBrowse({
      regionSlug,
      dong: dong || undefined,
      gu: gu && gu !== "all" ? gu : undefined,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "동별 단지 목록을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
