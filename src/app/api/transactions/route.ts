import { NextRequest, NextResponse } from "next/server";
import { getTransactions } from "@/lib/molit/service";
import type { AreaFilter, DealType } from "@/types/transaction";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const aptName = searchParams.get("aptName") ?? "";
  const dong = searchParams.get("dong") ?? "all";
  const dealType = (searchParams.get("dealType") ?? "all") as DealType | "all";
  const area = (searchParams.get("area") ?? "all") as AreaFilter;
  const yearMonth = searchParams.get("yearMonth") ?? undefined;
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "15");

  try {
    const data = await getTransactions({
      aptName,
      dong,
      dealType,
      area,
      yearMonth,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 15,
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
