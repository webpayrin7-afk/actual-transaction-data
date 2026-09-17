/**
 * Server-only school district seed loader + product builder.
 * Seed is statically imported so Vercel/Next bundles it (no cwd readFile).
 */

import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import type {
  ProductSchoolDistrict,
  ProductSchoolDistrictsPayload,
  SchoolDistrictConfidence,
  SchoolDistrictLevel,
} from "@/lib/complex-detail/school-district";
import gangdongSongpaHighSeed from "../../../data/poc/school-district/seoul-high-gangdong-songpa.v1.json";

export type SchoolDistrictMemberSeed = {
  name: string;
  establishment: string;
  schoolType: string;
  selection: string;
  neisSdSchulCode: string | null;
  roadAddress?: string | null;
};

export type SchoolDistrictSeed = {
  id: string;
  level: SchoolDistrictLevel;
  officialName: string;
  jurisdictionGu: string[];
  educationOffice: string;
  status: "CONFIRMED" | "HOLD";
  source: {
    provider: string;
    kind: string;
    hakgoonCode?: string;
    retrievedAt: string;
    schoolYear: string | null;
    note?: string;
  };
  members: SchoolDistrictMemberSeed[];
  complexLinks: Array<{
    complexId: string;
    aptNames: string[];
    resolutionMethod: string;
    confidence: SchoolDistrictConfidence;
    basis: string;
  }>;
};

export function loadGangdongSongpaHighSeed(): SchoolDistrictSeed {
  return gangdongSongpaHighSeed as SchoolDistrictSeed;
}

function isPilotComplex(params: {
  aptName: string;
  complexId?: string | null;
}): boolean {
  const id = params.complexId?.trim();
  if (id && id === JAMSIL_ELS_MAP_PILOT.complexId) return true;
  return isJamsilElsSchoolPilot(params.aptName);
}

export function buildSchoolDistrictsPayload(params: {
  aptName: string;
  complexId?: string | null;
}): ProductSchoolDistrictsPayload {
  if (!isPilotComplex(params)) {
    return {
      middle: null,
      high: null,
      middleStatus: "NOT_APPLICABLE",
      highStatus: "NOT_APPLICABLE",
    };
  }

  const seed = loadGangdongSongpaHighSeed();
  const link =
    seed.complexLinks.find(
      (l) => l.complexId === JAMSIL_ELS_MAP_PILOT.complexId,
    ) ?? seed.complexLinks[0];

  const high: ProductSchoolDistrict | null =
    seed.status === "CONFIRMED" && link
      ? {
          id: seed.id,
          level: "high",
          officialName: seed.officialName,
          description: "이 주소가 속한 일반학교군입니다.",
          infoText:
            "학교군 소속 학교는 실제 배정학교를 의미하지 않습니다. 실제 배정은 지원·추첨 및 교육청 배정 기준 등에 따라 달라질 수 있습니다.",
          schoolYear: seed.source.schoolYear,
          confidence: link.confidence,
          memberCount: seed.members.length,
          members: seed.members.map((m) => ({
            name: m.name,
            establishment: m.establishment,
            schoolCode: m.neisSdSchulCode?.trim() || null,
            roadAddress: m.roadAddress?.trim() || null,
            distanceM: null,
            detailLinkable: Boolean(m.neisSdSchulCode?.trim()),
            isNearby: false,
          })),
          attributionLabel: seed.source.provider,
        }
      : null;

  return {
    middle: null,
    high,
    middleStatus: "HOLD_UNCONFIRMED",
    highStatus: high ? "CONFIRMED" : "HOLD_UNCONFIRMED",
  };
}
