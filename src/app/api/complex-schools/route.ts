import { NextRequest, NextResponse } from "next/server";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";
import {
  fetchJamsilElsPilotSchools,
  type SchoolPilotStatus,
} from "@/lib/complex-detail/neis";
import { resolveComplexCoordinates } from "@/lib/complex-detail/resolve-coords";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * Optional school enrichment — failure never affects apt detail rendering.
 * Phase 8.1: real NEIS for 잠실엘스 only; catchment HOLD unless officially verified.
 */
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

    if (!isJamsilElsSchoolPilot(aptName)) {
      return NextResponse.json({
        status: "PILOT_ONLY" satisfies SchoolPilotStatus,
        reason: "학군 실데이터 연결은 잠실엘스 pilot만 지원합니다.",
        assignmentSupported: false,
        schools: [],
        catchment: null,
        attribution: null,
        distanceBasis: null,
        dataAsOf: null,
        complexHasCoords: !!coords,
      });
    }

    const result = await fetchJamsilElsPilotSchools({
      aptName,
      coords,
    });

    return NextResponse.json({
      status: result.status,
      reason: result.reason,
      assignmentSupported: false,
      schools: result.schools,
      catchment: {
        decision: result.catchment.decision,
        candidateSchoolName: result.catchment.candidateSchoolName,
        evidence: result.catchment.evidence,
        neededSources: result.catchment.neededSources,
      },
      attribution: result.attribution,
      distanceBasis: result.distanceBasis,
      dataAsOf: result.dataAsOf,
      complexHasCoords: !!coords,
      distanceType: "straight_line",
    });
  } catch (err) {
    console.error(
      "[complex-schools]",
      err instanceof Error ? err.message : "error",
    );
    return NextResponse.json({
      status: "API_ERROR" satisfies SchoolPilotStatus,
      reason: "학군 정보를 불러오지 못했습니다.",
      assignmentSupported: false,
      schools: [],
      catchment: null,
      attribution: null,
      distanceBasis: null,
      dataAsOf: null,
      complexHasCoords: false,
    });
  }
}
