/**
 * Server-only elementary attendance-zone seed loader + product builder.
 */

import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import type {
  AttendanceZoneConfidence,
  ProductAttendanceSchool,
  ProductAttendanceZone,
  ProductAttendanceZonePayload,
} from "@/lib/complex-detail/attendance-zone";
import { getDb } from "@/lib/db/client";
import {
  ELEM_ZONE_NOTE,
  ELEM_ZONE_SOURCE_LABEL,
  readComplexElemZones,
  type ElemZoneSchool,
} from "@/lib/complex-detail/elem-school-zone-server";
import jamIlElementarySeed from "../../../data/poc/attendance-zone/seoul-jamsil-jam-il-elementary.v1.json";

export type AttendanceZoneSeed = {
  id: string;
  type: "attendance_zone";
  officialName: string;
  zoneKind: "single" | "joint";
  hakgudoId: string;
  hakgudoGb: string;
  educationOffice: string;
  status: "CONFIRMED" | "HOLD";
  source: {
    provider: string;
    kind: string;
    dataset?: string;
    baseDate: string | null;
    retrievedAt: string;
    schoolYear: string | null;
    updateCycle?: string;
    note?: string;
  };
  designatedSchool: {
    name: string;
    establishment: string;
    neisSdSchulCode: string | null;
    roadAddress?: string | null;
  };
  complexLinks: Array<{
    complexId: string;
    aptNames: string[];
    resolutionMethod: string;
    confidence: AttendanceZoneConfidence;
    basis: string;
  }>;
};

function isPilotComplex(params: {
  aptName: string;
  complexId?: string | null;
}): boolean {
  const id = params.complexId?.trim();
  if (id && id === JAMSIL_ELS_MAP_PILOT.complexId) return true;
  return isJamsilElsSchoolPilot(params.aptName);
}

export function loadJamIlElementaryAttendanceSeed(): AttendanceZoneSeed {
  return jamIlElementarySeed as AttendanceZoneSeed;
}

function toProductSchool(s: ElemZoneSchool): ProductAttendanceSchool {
  return {
    name: s.name,
    establishment: s.establishment ?? "",
    schoolCode: s.schoolCode,
    roadAddress: s.roadAddress,
    distanceM: null,
    detailLinkable: Boolean(s.schoolCode),
    isNearby: false,
    walkMin: s.walkMin,
  };
}

/**
 * 미리 계산한 통학구역(complex_elem_school_zones)으로 만든 배정 초등학교.
 * 계산 행이 없으면 null — 부르는 쪽이 (잠실엘스 시범 seed 등) 다른 길로.
 */
export async function readAttendanceZonePayloadFromDb(
  complexId: string | null | undefined,
): Promise<ProductAttendanceZonePayload | null> {
  const id = complexId?.trim();
  const db = getDb();
  if (!id || !db) return null;
  const data = await readComplexElemZones(db, id, { walk: true }).catch(() => null);
  if (!data?.zones.length) return null;

  const single = data.zones.filter((z) => z.kind === "single");
  const joint = data.zones.filter((z) => z.kind === "joint");
  const designated = single.flatMap((z) => z.schools);
  const seen = new Set(designated.map((s) => s.name));
  const jointSchools: ElemZoneSchool[] = [];
  for (const s of joint.flatMap((z) => z.schools)) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    jointSchools.push(s);
  }
  const jointNoSchool = joint.find((z) => !z.schools.length) ?? null;
  const main = single[0] ?? joint[0]!;
  const month = data.baseDate?.slice(0, 7) ?? null;

  const elementary: ProductAttendanceZone = {
    id: `elem-zone-${main.zoneId}`,
    type: "attendance_zone",
    officialName: main.name,
    zoneKind: single.length ? "single" : "joint",
    description: "이 주소의 초등학교 통학구역입니다.",
    infoText: "",
    ctaLabel: "",
    schoolYear: null,
    baseDate: data.baseDate,
    confidence: "DERIVED",
    designatedSchools: designated.map(toProductSchool),
    jointSchools: jointSchools.map(toProductSchool),
    jointZoneName: jointNoSchool && !jointSchools.length ? jointNoSchool.name : null,
    note: `${month ? `통학구역 기준일 ${month} · ` : ""}${ELEM_ZONE_NOTE}`,
    attributionLabel: ELEM_ZONE_SOURCE_LABEL,
  };
  return { elementary, elementaryStatus: "CONFIRMED" };
}

export function buildAttendanceZonePayload(params: {
  aptName: string;
  complexId?: string | null;
}): ProductAttendanceZonePayload {
  if (!isPilotComplex(params)) {
    return {
      elementary: null,
      elementaryStatus: "NOT_APPLICABLE",
    };
  }

  const seed = loadJamIlElementaryAttendanceSeed();
  const link =
    seed.complexLinks.find(
      (l) => l.complexId === JAMSIL_ELS_MAP_PILOT.complexId,
    ) ?? seed.complexLinks[0];

  if (seed.status !== "CONFIRMED" || !link || seed.zoneKind !== "single") {
    return {
      elementary: null,
      elementaryStatus: "HOLD_UNCONFIRMED",
    };
  }

  const code = seed.designatedSchool.neisSdSchulCode?.trim() || null;
  const elementary: ProductAttendanceZone = {
    id: seed.id,
    type: "attendance_zone",
    officialName: seed.officialName,
    zoneKind: seed.zoneKind,
    description: "이 주소의 초등학교 통학구역입니다.",
    infoText:
      "거주지 주소가 속한 공식 통학구역입니다. 실제 취학·전학 절차는 관할 교육지원청·동 주민센터 안내를 따릅니다.",
    ctaLabel: "통학구역 정보 보기",
    schoolYear: seed.source.schoolYear,
    baseDate: seed.source.baseDate,
    confidence: link.confidence,
    designatedSchools: [
      {
        name: seed.designatedSchool.name,
        establishment: seed.designatedSchool.establishment,
        schoolCode: code,
        roadAddress: seed.designatedSchool.roadAddress?.trim() || null,
        distanceM: null,
        detailLinkable: Boolean(code),
        isNearby: false,
      },
    ],
    attributionLabel: seed.source.provider,
  };

  return {
    elementary,
    elementaryStatus: "CONFIRMED",
  };
}
