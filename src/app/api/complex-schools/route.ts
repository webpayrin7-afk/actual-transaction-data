import { NextRequest, NextResponse } from "next/server";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { fetchNearbySchools } from "@/lib/complex-detail/neis";
import { resolveComplexCoordinates } from "@/lib/complex-detail/resolve-coords";
import { neisReadiness } from "@/lib/complex-detail/source-status";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** Optional school enrichment — failure never affects apt detail rendering. */
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

    const readiness = neisReadiness(!!coords);
    if (readiness.status !== "READY") {
      return NextResponse.json({
        status: readiness.status,
        reason: readiness.reason,
        assignmentSupported: false,
        schools: [],
        attribution: null,
      });
    }

    const schools = await fetchNearbySchools({ coords: coords! });
    if (schools.length === 0) {
      return NextResponse.json({
        status: "DATA_SOURCE_NOT_READY",
        reason:
          "NEIS 키가 있어도 좌표 기반 인근학교 조회에 필요한 교육청 코드 매핑이 아직 없어 보류합니다.",
        assignmentSupported: false,
        schools: [],
        attribution: "NEIS 교육정보개방포털",
      });
    }

    return NextResponse.json({
      status: "READY",
      reason: "",
      assignmentSupported: false,
      schools,
      attribution: "NEIS 교육정보개방포털",
      distanceType: "straight_line",
    });
  } catch (err) {
    console.error("[complex-schools]", err);
    return NextResponse.json({
      status: "ERROR",
      reason: "학군 정보를 불러오지 못했습니다.",
      assignmentSupported: false,
      schools: [],
      attribution: null,
    });
  }
}
