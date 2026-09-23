import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readCommerceSnapshot } from "@/lib/complex-detail/commerce-db";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * National SEMAS commerce snapshot (1km, current publication) + P2 point cloud.
 * { status: "ok", snapshot } | { status: "empty" } when the complex has no snapshot
 * (no coordinate) — the client then falls back to ComplexLivingCensus.
 */
export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
  try {
    const snapshot = await readCommerceSnapshot(db, complexId, 1000);
    return NextResponse.json(
      snapshot ? { status: "ok", snapshot } : { status: "empty" },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}
