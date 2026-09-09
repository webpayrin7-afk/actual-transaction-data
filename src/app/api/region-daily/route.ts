import { NextRequest, NextResponse } from "next/server";
import { getRegion } from "@/lib/constants/regions";
import { getRegionDaily, type RegionDailyPart } from "@/lib/molit/service";

export const revalidate = 60;
export const maxDuration = 60;

const PARTS = new Set<RegionDailyPart>([
  "market",
  "latest",
  "history",
  "days",
  "all",
]);

export async function GET(request: NextRequest) {
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const yearMonth = request.nextUrl.searchParams.get("yearMonth")?.trim() ?? "";
  const contractMonth =
    request.nextUrl.searchParams.get("contractMonth")?.trim() ?? "";
  const date = request.nextUrl.searchParams.get("date")?.trim() ?? "";
  const dates = request.nextUrl.searchParams.get("dates")?.trim() ?? "";
  const offsetRaw = request.nextUrl.searchParams.get("offset")?.trim() ?? "";
  const partRaw = request.nextUrl.searchParams.get("part")?.trim() ?? "all";
  const part = PARTS.has(partRaw as RegionDailyPart)
    ? (partRaw as RegionDailyPart)
    : "all";
  const offset = Number.parseInt(offsetRaw, 10);

  if (!regionSlug || !getRegion(regionSlug)) {
    return NextResponse.json({ error: "유효한 region이 필요합니다." }, { status: 400 });
  }

  try {
    const data = await getRegionDaily({
      regionSlug,
      yearMonth: yearMonth || undefined,
      contractMonth: contractMonth || undefined,
      date: date || undefined,
      dates: dates ? dates.split(",").map((d) => d.trim()).filter(Boolean) : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      part,
    });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "새로 확인된 거래를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
