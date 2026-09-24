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
import gangdongSongpa3MiddleSeed from "../../../data/poc/school-district/seoul-middle-gangdong-songpa-3.v1.json";

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

export function loadGangdongSongpa3MiddleSeed(): SchoolDistrictSeed {
  return gangdongSongpa3MiddleSeed as SchoolDistrictSeed;
}

function isPilotComplex(params: {
  aptName: string;
  complexId?: string | null;
}): boolean {
  const id = params.complexId?.trim();
  if (id && id === JAMSIL_ELS_MAP_PILOT.complexId) return true;
  return isJamsilElsSchoolPilot(params.aptName);
}

function toProductDistrict(
  seed: SchoolDistrictSeed,
  description: string,
  infoText: string,
): ProductSchoolDistrict | null {
  const link =
    seed.complexLinks.find(
      (l) => l.complexId === JAMSIL_ELS_MAP_PILOT.complexId,
    ) ?? seed.complexLinks[0];
  if (seed.status !== "CONFIRMED" || !link) return null;
  return {
    id: seed.id,
    level: seed.level,
    officialName: seed.officialName,
    description,
    infoText,
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
  };
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

  const high = toProductDistrict(
    loadGangdongSongpaHighSeed(),
    "이 주소가 속한 일반학교군입니다.",
    "학교군 소속 학교는 실제 배정학교를 의미하지 않습니다. 실제 배정은 지원·추첨 및 교육청 배정 기준 등에 따라 달라질 수 있습니다.",
  );

  const middle = toProductDistrict(
    loadGangdongSongpa3MiddleSeed(),
    "이 주소가 속한 중학교 학교군입니다.",
    "학교군 소속 학교는 실제 배정학교를 의미하지 않습니다. 중학교는 학교군 내 추첨·배정 기준에 따라 달라질 수 있습니다.",
  );

  return {
    middle,
    high,
    middleStatus: middle ? "CONFIRMED" : "HOLD_UNCONFIRMED",
    highStatus: high ? "CONFIRMED" : "HOLD_UNCONFIRMED",
  };
}
