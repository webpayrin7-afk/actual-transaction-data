import { NextRequest, NextResponse } from "next/server";
import { getRegion } from "@/lib/constants/regions";
import { getTransactions } from "@/lib/molit/service";
import type { AreaFilter, DealType } from "@/types/transaction";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const aptName = searchParams.get("aptName") ?? "";
  const gu = searchParams.get("gu") ?? "all";
  const dong = searchParams.get("dong") ?? "all";
  const dealType = (searchParams.get("dealType") ?? "all") as DealType | "all";
  const area = (searchParams.get("area") ?? "all") as AreaFilter;
  const yearMonth = searchParams.get("yearMonth") ?? undefined;
  const regionSlug = searchParams.get("region") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "15");

  if (!regionSlug) {
    return NextResponse.json(
      { error: "region 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  const region = getRegion(regionSlug);
  if (!region) {
    return NextResponse.json(
      { error: `지원하지 않는 지역입니다: ${regionSlug}` },
      { status: 400 },
    );
  }

  let lawdCodes = [...region.lawdCodes];

  // 구 단위로 좁히기 (예: 수원시 영통구만)
  if (gu && gu !== "all") {
    const matched = region.districts.filter(
      (d) => d.name === gu || d.name.includes(gu) || gu.includes(d.name),
    );
    if (matched.length) {
      lawdCodes = matched.map((d) => d.code);
    }
  }

  try {
    const data = await getTransactions({
      aptName,
      // 단일 구/시군은 lawdCodes로 이미 한정되므로 gu 문자열 필터는 생략
      gu: region.districts.length <= 1 ? "all" : gu,
      dong,
      dealType,
      area,
      yearMonth,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 15,
      lawdCodes,
      regionSlug: region.slug,
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "거래 데이터를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
