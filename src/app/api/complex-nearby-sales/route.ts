import { NextRequest, NextResponse } from "next/server";
import { fetchNearbySalesBySigungu } from "@/lib/complex-detail/applyhome-nearby-sales";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Optional nearby 분양 enrichment — isolated from market/mgmt rendering.
 * Server-only; serviceKey never sent to the browser.
 */
export async function GET(request: NextRequest) {
  const sigungu = request.nextUrl.searchParams.get("sigungu")?.trim() ?? "";

  try {
    const result = await fetchNearbySalesBySigungu(sigungu);
    return NextResponse.json(result);
  } catch (err) {
    console.error(
      "[complex-nearby-sales]",
      err instanceof Error ? err.message : "error",
    );
    return NextResponse.json({
      status: "ERROR",
      reason: "주변 분양 정보를 불러오지 못했습니다.",
      sigungu: sigungu || null,
      items: [],
      attribution: "출처: 청약홈 · 한국부동산원",
      notice: "청약 일정과 공급조건은 실제 입주자모집공고를 확인하세요.",
    });
  }
}
