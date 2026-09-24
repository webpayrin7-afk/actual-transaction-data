import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  LIVING_RADII_M,
  readComplexLiving,
} from "@/lib/living/read-snapshot";

export const dynamic = "force-dynamic";

/**
 * Read-only living snapshot. Does not scan SEMAS or compute distances.
 * GET /api/complex-living?complex_id=&radius=1000
 */
export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const radiusRaw = request.nextUrl.searchParams.get("radius")?.trim() ?? "1000";
  const radiusM = Number(radiusRaw);

  if (!complexId) {
    return NextResponse.json({ error: "complex_id is required" }, { status: 400 });
  }
  if (!LIVING_RADII_M.includes(radiusM as (typeof LIVING_RADII_M)[number])) {
    return NextResponse.json(
      { error: "radius must be 500 or 1000" },
      { status: 400 },
    );
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database unavailable" }, { status: 503 });
  }

  try {
    const body = await readComplexLiving(db, complexId, radiusM);
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    if (/no such table/i.test(message)) {
      return NextResponse.json(
        {
          complexId,
          radiusM,
          qualityStatus: "NO_SNAPSHOT",
          categories: [],
          held: [],
        },
        { status: 200 },
      );
    }
    return NextResponse.json({ error: "snapshot read failed" }, { status: 500 });
  }
}
