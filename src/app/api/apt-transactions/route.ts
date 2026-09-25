import { NextRequest, NextResponse } from "next/server";
import { getAptTransactionArchive } from "@/lib/apt/get-apt-transaction-archive";
import { parseTransactionTabType } from "@/lib/apt/transaction-type";
import { parseTransactionYear } from "@/lib/apt/transaction-year";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  const gu = request.nextUrl.searchParams.get("gu")?.trim() ?? "";
  const areaKey = request.nextUrl.searchParams.get("area")?.trim() || undefined;
  const type = parseTransactionTabType(
    request.nextUrl.searchParams.get("type"),
  );
  const year = parseTransactionYear(request.nextUrl.searchParams.get("year"));
  const offsetRaw = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "20");

  if (!aptName || !regionSlug) {
    return NextResponse.json(
      { error: "aptName과 region이 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const archive = await getAptTransactionArchive({
      aptName,
      regionSlug,
      gu: gu || undefined,
      areaKey,
      type,
      year,
      offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
      limit: Number.isFinite(limitRaw) ? limitRaw : 20,
    });
    if (!archive) {
      return NextResponse.json(
        { error: "단지를 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    const res = NextResponse.json(archive);
    res.headers.set(
      "Cache-Control",
      "private, max-age=60, stale-while-revalidate=300",
    );
    return res;
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "거래내역을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
