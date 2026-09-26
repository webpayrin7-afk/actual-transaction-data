import { NextResponse, type NextRequest } from "next/server";
import { FssFinlifeError, queryLoanRates } from "@/lib/rates/fss-finlife";
import { parseLoanRateFilters } from "@/lib/rates/loan-rate-model";

/**
 * 대출 금리 비교 — 금융감독원 금융상품통합비교공시(주택담보·전세자금대출).
 * ?kind=mortgage|jeonse&sector=&rateType=&repay=&collateral=&sort=min|avg
 * 요청한 조건의 상위 목록만 돌려준다.
 */
export async function GET(request: NextRequest) {
  const filters = parseLoanRateFilters(request.nextUrl.searchParams);
  try {
    const data = await queryLoanRates(filters);
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("[loan-rates]", error instanceof Error ? error.message : error);
    const message =
      error instanceof FssFinlifeError
        ? error.message
        : "금리 데이터를 불러오지 못했습니다.";
    const code = error instanceof FssFinlifeError ? error.code : "upstream";
    return NextResponse.json(
      { error: message, code },
      { status: code === "upstream" ? 502 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
