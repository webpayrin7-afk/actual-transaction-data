import { NextResponse } from "next/server";
import {
  resolveJamsilElsCanonicalAddress,
  resolveJamsilElsCoordinate,
} from "@/lib/nearby-map/geocode";
import {
  JAMSIL_ELS_MAP_PILOT,
  SCHOOL_CATCHMENT_AUDIT,
} from "@/lib/nearby-map/jamsil-els-pilot";
import { loadNearbySchools } from "@/lib/nearby-map/neis-schools";
import { loadNearbyPois } from "@/lib/nearby-map/vworld-poi";
import { formatStraightDistanceLabel } from "@/lib/nearby-map/geo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dev-only pilot payload for /dev/nearby-school.
 * No production DB writes. No bulk enrichment.
 */
export async function GET() {
  const t0 = performance.now();
  const [coord, address] = await Promise.all([
    resolveJamsilElsCoordinate(),
    resolveJamsilElsCanonicalAddress(),
  ]);

  const schools = coord.coordinate
    ? await loadNearbySchools(coord.coordinate)
    : {
        ok: false,
        schools: [],
        elementary: [],
        middle: [],
        high: [],
        note: "Coordinate unavailable — school distance not computed",
        catchment: SCHOOL_CATCHMENT_AUDIT,
      };

  const pois = coord.coordinate
    ? await loadNearbyPois(coord.coordinate)
    : {
        ok: false,
        transit: [],
        living: [],
        medical: [],
        note: "Coordinate unavailable — POI distance not computed",
        naverLocalPlaceStatus: "NOT_AVAILABLE_WITH_MAPS_JS_KEY" as const,
      };

  const schoolItems = schools.schools.map((s) => ({
    id: s.id,
    name: s.name,
    level:
      s.schoolType === "초등학교"
        ? ("elementary" as const)
        : s.schoolType === "중학교"
          ? ("middle" as const)
          : s.schoolType === "고등학교"
            ? ("high" as const)
            : ("other" as const),
    schoolType: s.schoolType,
    foundation: s.fondType,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    distanceM: s.distanceM,
    distanceLabel: formatStraightDistanceLabel(s.distanceM),
    classification: s.classification,
    source: s.source,
  }));

  const poiItems = [...pois.transit, ...pois.living, ...pois.medical].map(
    (p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      subcategory: p.subcategory,
      lat: p.lat,
      lng: p.lng,
      distanceM: p.distanceM,
      distanceLabel: formatStraightDistanceLabel(p.distanceM),
      source: p.source,
    })
  );

  const nearestTransit = pois.transit[0] ?? null;
  const nearestElementary = schools.elementary[0] ?? null;
  const medicalCount1km = pois.medical.filter((m) => m.distanceM <= 1000)
    .length;

  return NextResponse.json({
    complex: {
      name: JAMSIL_ELS_MAP_PILOT.displayName,
      complexId: coord.complexId,
      complexKey: JAMSIL_ELS_MAP_PILOT.complexKey,
      kaptCode: JAMSIL_ELS_MAP_PILOT.kaptCode,
      coords: coord.coordinate,
      coordSource: coord.source,
      coordClassification: coord.classification,
      coordAccuracy: coord.accuracy,
      coordMethod: coord.method,
      coordArtifact: coord.sourceArtifact,
      coordDetail: coord.note,
      address: address.address,
      addressAvailable: address.available,
      addressType: address.addressType,
      addressSource: address.source,
      addressDetail: address.note,
    },
    catchment: {
      decision: SCHOOL_CATCHMENT_AUDIT.assignedSchoolVerified
        ? ("VERIFIED" as const)
        : ("HOLD" as const),
      assignedSchoolVerified: SCHOOL_CATCHMENT_AUDIT.assignedSchoolVerified,
      schoolDistrictVerified: SCHOOL_CATCHMENT_AUDIT.schoolDistrictVerified,
      candidateSchoolName: nearestElementary?.name ?? "",
      evidence: SCHOOL_CATCHMENT_AUDIT.note,
      classes: {
        nearby: SCHOOL_CATCHMENT_AUDIT.nearbySchoolClass,
        assigned: SCHOOL_CATCHMENT_AUDIT.assignedSchoolClass,
        districtUnverified: SCHOOL_CATCHMENT_AUDIT.districtUnverifiedClass,
      },
    },
    summary: {
      transit: nearestTransit
        ? {
            label: "지하철",
            value: `가까운 역 ${formatStraightDistanceLabel(nearestTransit.distanceM).replace("직선거리 ", "")}`,
            name: nearestTransit.name,
          }
        : null,
      elementary: nearestElementary
        ? {
            label: "초등학교",
            value: `가까운 학교 ${formatStraightDistanceLabel(nearestElementary.distanceM).replace("직선거리 ", "")}`,
            name: nearestElementary.name,
            classification: "NEARBY_SCHOOL" as const,
          }
        : null,
      medical:
        pois.medical.length > 0
          ? { label: "병원", value: `${medicalCount1km}곳 / 1km` }
          : null,
    },
    schools: {
      status: schools.ok ? ("OK" as const) : ("UNAVAILABLE" as const),
      reason: schools.note,
      items: schoolItems,
      counts: {
        elementary: schools.elementary.length,
        middle: schools.middle.length,
        high: schools.high.length,
        total: schools.schools.length,
      },
    },
    pois: {
      status: pois.ok ? ("OK" as const) : ("UNAVAILABLE" as const),
      reason: pois.note,
      items: poiItems,
      categories: {
        transit: pois.transit.length,
        living: pois.living.length,
        medical: pois.medical.length,
      },
      naverLocalPlaceApi: pois.naverLocalPlaceStatus,
    },
    meta: {
      distanceMethod:
        "haversine straight-line (WGS84) · src/lib/nearby-map/geo.ts · labeled 직선거리",
      naverMapsJs:
        "AVAILABLE (Web Dynamic Map SDK via NEXT_PUBLIC_NAVER_MAP_CLIENT_ID)",
      geocoding:
        "DEV: NAVER Maps Geocoder fallback when coords null (coordSource=NAVER_GEOCODE); VWorld optional for POI/school only",
      reverseGeocoding: "NOT CONFIGURED",
      naverLocalPlaceSearch: "NOT_AVAILABLE_WITH_MAPS_JS_KEY",
      elapsedMs: Math.round(performance.now() - t0),
      pilotOnly: true,
    },
    sources: [
      {
        feature: "잠실엘스 location",
        source: coord.source,
        license: "warehouse / VWorld public GIS",
        coordinateSource: coord.source,
        refreshNeed: "static until master enrichment",
      },
      {
        feature: "nearby schools",
        source: "NEIS schoolInfo",
        license: "NEIS OpenAPI (공공데이터)",
        coordinateSource: "VWorld geocode of NEIS road address",
        refreshNeed: "periodic",
      },
      {
        feature: "transit / living / medical POI",
        source: "VWorld place search",
        license: "VWorld (공공 GIS)",
        coordinateSource: "VWorld",
        refreshNeed: "slow-changing",
      },
      {
        feature: "map renderer",
        source: "NAVER Cloud Platform Web Dynamic Map",
        license: "NAVER Maps (attribution required)",
        coordinateSource: "n/a (renderer only)",
        refreshNeed: "n/a",
      },
    ],
  });
}
