import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readNearbySchools } from "@/lib/school-national/read";

export const dynamic = "force-dynamic";

/**
 * DB snapshot read. No SchoolInfo call.
 * NO_COORDINATE and NOT_MATERIALIZED return schools: null, never an empty list
 * that would mean "there are no schools nearby."
 */
export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complexId")?.trim() ?? "";
  if (!complexId) {
    return NextResponse.json({ error: "complexId가 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database unavailable", liveSourceCalls: 0 }, { status: 503 });
  }
  const started = performance.now();
  try {
    const nearby = await readNearbySchools(db, complexId);
    const elapsedMs = Math.round(performance.now() - started);
    const res = NextResponse.json({ ...nearby, elapsedMs });
    res.headers.set("X-Db-Read-Ms", String(elapsedMs));
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    return NextResponse.json({ error: message, liveSourceCalls: 0 }, { status: 500 });
  }
}
