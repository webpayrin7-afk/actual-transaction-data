import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { applyWalker, type WalkPayload } from "@/lib/complex-3d/walk";
import { isWalkerId } from "@/lib/complex-3d/walker-profiles";
import { getWalkPayload } from "@/lib/complex-3d/walk-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 걷기 경로 — 단지(동) → 가까운 역 출구·초·중학교·버스정류장. OSM 길 + 지형 경사 + 횡단 대기.
 * `?from=<building_id>` 출발 동 (없으면 단지 가운데 동), `?mode=wheel` 계단 피하기(유모차·휠체어),
 * `?walker=male|female|child|elder` 걷는 사람 속도 (없으면 기본 4.5km/h — 저장된 결과 그대로). 시간 바꾸기도 서버에서.
 * 저장된 결과·보행망(complex_walk_routes / complex_walk_osm)을 먼저 쓰고, 없을 때만 Overpass 거울 서버를 짧게 부른다.
 * 계산은 모두 서버에서 — 브라우저에는 결과 경로만.
 */
const memo = new Map<string, { at: number; p: Promise<Awaited<ReturnType<typeof getWalkPayload>>> }>();
const MEMO_TTL = 3600_000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  const fromRaw = request.nextUrl.searchParams.get("from");
  const from = fromRaw && /^[\w:.-]{1,80}$/.test(fromRaw) ? fromRaw : null;
  const mode = request.nextUrl.searchParams.get("mode") === "wheel" ? "wheel" : "walk";
  const walkerRaw = request.nextUrl.searchParams.get("walker");
  const walker = isWalkerId(walkerRaw) ? walkerRaw : null;
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });

  const key = `${complexId}|${from ?? ""}|${mode}`;
  let hit = memo.get(key);
  if (!hit || Date.now() - hit.at > MEMO_TTL) {
    const p = getWalkPayload(db, complexId, { from, mode });
    hit = { at: Date.now(), p };
    memo.set(key, hit);
    p.catch(() => memo.delete(key));
    while (memo.size > 200) memo.delete(memo.keys().next().value!);
  }
  try {
    const r = await hit.p;
    if (!r) return NextResponse.json({ error: "단지를 찾지 못했습니다." }, { status: 404 });
    // 기본 결과(메모·저장본)는 걷는 사람과 상관없이 하나 — 속도 비율만 여기서 곱한다
    const body: WalkPayload = walker ? applyWalker(r.payload, walker) : r.payload;
    return NextResponse.json(body, {
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000",
        "X-Walk-Source": r.source,
      },
    });
  } catch (error) {
    memo.delete(key);
    console.error("[complex-3d walk]", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "걷기 경로를 지금 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
