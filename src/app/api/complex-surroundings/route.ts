import { NextRequest, NextResponse } from "next/server";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { resolveComplexCoordinates } from "@/lib/complex-detail/resolve-coords";
import { vworldReadiness } from "@/lib/complex-detail/source-status";
import { fetchNearbySurroundings } from "@/lib/complex-detail/vworld";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** Optional surroundings enrichment — isolated from core apt detail. */
export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const lawdCd = request.nextUrl.searchParams.get("lawdCd")?.trim() || null;
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lng = Number(request.nextUrl.searchParams.get("lng"));

  if (!aptName) {
    return NextResponse.json({ error: "aptName required" }, { status: 400 });
  }

  try {
    const coords = isValidLatLng({ lat, lng })
      ? { lat, lng }
      : await resolveComplexCoordinates({ aptName, lawdCd });

    const readiness = vworldReadiness(!!coords);
    if (readiness.status !== "READY") {
      return NextResponse.json({
        status: readiness.status,
        reason: readiness.reason,
        places: [],
        attribution: null,
        distanceType: "straight_line",
        routing: false,
      });
    }

    const places = await fetchNearbySurroundings({ coords: coords! });
    return NextResponse.json({
      status: places.length > 0 ? "READY" : "ERROR",
      reason:
        places.length > 0
          ? ""
          : "주변시설 검색 결과가 없거나 VWorld 응답이 비었습니다.",
      places,
      attribution: "출처: VWorld",
      distanceType: "straight_line",
      routing: false,
    });
  } catch (err) {
    console.error("[complex-surroundings]", err);
    return NextResponse.json({
      status: "ERROR",
      reason: "주변환경 정보를 불러오지 못했습니다.",
      places: [],
      attribution: null,
      distanceType: "straight_line",
      routing: false,
    });
  }
}
