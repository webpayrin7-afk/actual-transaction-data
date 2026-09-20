import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readSchoolDetail } from "@/lib/school-national/read";

export const dynamic = "force-dynamic";

/** DB snapshot read. Does not call SchoolInfo. */
export async function GET(request: NextRequest) {
  const schoolCode = request.nextUrl.searchParams.get("schoolCode")?.trim() ?? "";
  if (!schoolCode) {
    return NextResponse.json({ error: "schoolCode가 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database unavailable", liveSourceCalls: 0 }, { status: 503 });
  }
  const started = performance.now();
  try {
    const detail = await readSchoolDetail(db, schoolCode);
    const elapsedMs = Math.round(performance.now() - started);
    const res = NextResponse.json({ ...detail, elapsedMs });
    res.headers.set("X-Db-Read-Ms", String(elapsedMs));
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "read failed";
    return NextResponse.json({ error: message, liveSourceCalls: 0 }, { status: 500 });
  }
}
