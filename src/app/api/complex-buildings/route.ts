import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { loadComplexBuildingsApi } from "@/lib/buildings/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  if (!complexId) {
    return NextResponse.json({ error: "complex_id is required" }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database unavailable" }, { status: 503 });
  }
  try {
    const payload = await loadComplexBuildingsApi(db, complexId);
    if (!payload) {
      return NextResponse.json({ error: "complex not found" }, { status: 404 });
    }
    const res = NextResponse.json(payload);
    res.headers.set(
      "Cache-Control",
      payload.status === "EXACT"
        ? "private, max-age=600, stale-while-revalidate=3600"
        : "private, max-age=120, stale-while-revalidate=600",
    );
    return res;
  } catch (error) {
    console.error("[complex-buildings]", error);
    return NextResponse.json({ error: "failed to load complex buildings" }, { status: 500 });
  }
}
