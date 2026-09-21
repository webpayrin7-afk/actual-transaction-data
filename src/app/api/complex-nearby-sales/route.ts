import { NextRequest, NextResponse } from "next/server";
import { fetchNearbySalesBySigungu } from "@/lib/complex-detail/applyhome-nearby-sales";
import { SUPPLY_UNAVAILABLE_MESSAGE } from "@/lib/complex-detail/nearby-supply";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Sigungu supply feed. Server-only; the public-data key never leaves this route.
 */
export async function GET(request: NextRequest) {
  const sigungu = request.nextUrl.searchParams.get("sigungu")?.trim() ?? "";

  try {
    const result = await fetchNearbySalesBySigungu(sigungu);
    const res = NextResponse.json(result);
    res.headers.set(
      "Cache-Control",
      result.status === "UNAVAILABLE"
        ? "no-store"
        : "public, s-maxage=86400, stale-while-revalidate=86400",
    );
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    console.error(
      "[complex-nearby-sales]",
      msg.replace(/serviceKey=[^&\s]+/gi, "serviceKey=(redacted)"),
    );
    return NextResponse.json(
      {
        status: "UNAVAILABLE",
        message: SUPPLY_UNAVAILABLE_MESSAGE,
        sigungu: sigungu || null,
        scope: "SIGUNGU",
        items: [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
