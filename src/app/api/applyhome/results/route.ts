import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readApplyhomeResults, type ResultsQuery } from "@/lib/applyhome/read";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
  v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** 분양 결과 — 최근 12개월 주택형별 청약 결과 (지역·공급·면적·분양가 필터, 15건씩) */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const q: ResultsQuery = {
    metro: /^[a-z]+$/.test(sp.get("metro") ?? "") ? sp.get("metro")! : "all",
    supplier: pick(sp.get("supplier"), ["all", "private", "public"] as const, "all"),
    area: pick(sp.get("area"), ["all", "s", "m", "l"] as const, "all"),
    price: pick(sp.get("price"), ["all", "p1", "p2", "p3", "p4"] as const, "all"),
    page: Math.max(1, Number(sp.get("page")) || 1),
  };
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readApplyhomeResults(db, q);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[applyhome-results]", error);
    return NextResponse.json({ error: "분양 결과를 불러오지 못했습니다." }, { status: 500 });
  }
}
