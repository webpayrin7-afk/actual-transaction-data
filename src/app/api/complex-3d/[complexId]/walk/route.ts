import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readComplex3d } from "@/lib/complex-3d/read";
import { railStationsBoxStatement, rankNearbyRailStations } from "@/lib/transit/rail-stations";
import { computeWalkRoutes, type WalkPayload } from "@/lib/complex-3d/walk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 걷기 경로 — 단지(동) → 가까운 역 출구·초·중학교·버스정류장. OSM 길 + 지형 경사 + 횡단 대기.
 * `?from=<building_id>` 출발 동 (없으면 단지 가운데 동), `?mode=wheel` 계단 피하기(유모차·휠체어).
 * DB는 읽기만. 계산 결과는 메모리 + CDN에 오래 둔다 (OSM 길은 자주 안 바뀐다).
 */
const memo = new Map<string, { at: number; p: Promise<WalkPayload> }>();
const MEMO_TTL = 3600_000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  const fromRaw = request.nextUrl.searchParams.get("from");
  const from = fromRaw && /^[\w:.-]{1,80}$/.test(fromRaw) ? fromRaw : null;
  const mode = request.nextUrl.searchParams.get("mode") === "wheel" ? "wheel" : "walk";
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });

  const key = `${complexId}|${from ?? ""}|${mode}`;
  let hit = memo.get(key);
  if (!hit || Date.now() - hit.at > MEMO_TTL) {
    const p = (async () => {
      const base = await readComplex3d(db, complexId, { shapesOnly: true });
      if (!base) throw Object.assign(new Error("not found"), { status: 404 });
      const [mRows, schoolRows, railRows] = (
        await db.batch(
          [
            { sql: `SELECT sigungu FROM apt_complex_master WHERE complex_id = ?`, args: [complexId] },
            {
              sql: `SELECT s.school_name, s.school_level, s.lat, s.lng FROM complex_nearby_schools n
                    JOIN school_master s ON s.school_code = n.school_code
                    WHERE n.complex_id = ? AND s.lat IS NOT NULL ORDER BY n.distance_m LIMIT 12`,
              args: [complexId],
            },
            railStationsBoxStatement(base.center, 1100),
          ],
          "read",
        )
      ).map((r) => r.rows);
      const sigungu = mRows![0]?.sigungu ? String(mRows![0].sigungu).split(/\s+/).pop()! : null;
      return computeWalkRoutes(
        {
          complexId,
          center: base.center,
          sigungu,
          buildings: base.buildings.map((b) => ({ id: b.id, dong: b.dong, residential: b.residential, rings: b.rings })),
          schools: schoolRows!.map((r) => ({ name: String(r.school_name), level: r.school_level == null ? null : String(r.school_level), lat: Number(r.lat), lng: Number(r.lng) })),
          stations: rankNearbyRailStations(railRows!, base.center, 1100, 6).map((s) => ({ name: s.name, lines: s.lines, lat: s.lat, lng: s.lng })),
        },
        { from, mode },
      );
    })();
    hit = { at: Date.now(), p };
    memo.set(key, hit);
    p.catch(() => memo.delete(key));
    while (memo.size > 200) memo.delete(memo.keys().next().value!);
  }
  try {
    const data = await hit.p;
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000" },
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return NextResponse.json({ error: "단지를 찾지 못했습니다." }, { status: 404 });
    console.error("[complex-3d walk]", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "걷기 경로를 지금 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
