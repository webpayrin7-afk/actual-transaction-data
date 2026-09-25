import { NextRequest, NextResponse } from "next/server";
import { fetchNearbySales } from "@/lib/complex-detail/applyhome-nearby-sales";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_LAWD_CODES = 12;

/**
 * Optional nearby 분양 enrichment — isolated from market/mgmt rendering.
 * ?lawd=41135 (여러 구면 쉼표로) — 시군구 코드 정확 일치. ?sigungu= 는 표시 이름 · 오피스텔 검색어.
 * Server-only; serviceKey never sent to the browser.
 */
export async function GET(request: NextRequest) {
  const sigungu = request.nextUrl.searchParams.get("sigungu")?.trim() ?? "";
  const lawdCodes = [
    ...new Set(
      (request.nextUrl.searchParams.get("lawd") ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^\d{5}$/.test(c)),
    ),
  ].slice(0, MAX_LAWD_CODES);

  try {
    const result = await fetchNearbySales({ lawdCodes, sigungu });
    const cacheable = result.status === "READY" || result.status === "EMPTY";
    return NextResponse.json(result, {
      headers: cacheable
        ? { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=21600" }
        : undefined,
    });
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
