/**
 * National SCHOOL nearby background runner helpers.
 *
 * Ownership: complex_nearby_* only for nearby waves.
 * Complex coordinates are read-only (LIVING PARCEL_REPRESENTATIVE_POINT).
 * Does not invent assignment/배정 semantics.
 */

import {
  buildSchoolGrid,
  isSafeParcelPoint,
  linksWithinRadius,
  nearbyDeltaAction,
  parcelCoordVersion,
  schoolsNearCell,
  type NearbySchoolPoint,
} from "./nearby-delta";
import { DISTANCE_BASIS, NEARBY_CLASSIFICATION, NEARBY_RADIUS_M } from "./parse";

export const RUNNER_VERSION = 1;
export const DEPENDENCY_POLL_MS = 15 * 60 * 1000; // 15 minutes — no tight polling
export const BATCH_SIZE = 8;
export const HEARTBEAT_EVERY_N = 25;

export type TargetStatus =
  | "READY_NEARBY"
  | "WAIT_COORDINATE"
  | "READY_DETAIL"
  | "COMPLETE"
  | "NO_NEARBY_SCHOOL"
  | "NO_SOURCE"
  | "FAILED_RETRYABLE";

export type TargetPriority = "P0_SEOUL" | "P1_GYEONGGI" | "P2_LIVING_FOLLOW" | "P3_NATIONAL" | "P4_DETAIL";

export type RegionCode =
  | "SEOUL"
  | "GYEONGGI"
  | "INCHEON"
  | "BUSAN"
  | "DAEGU"
  | "DAEJEON"
  | "GWANGJU"
  | "ULSAN"
  | "SEJONG"
  | "GANGWON"
  | "CHUNGBUK"
  | "CHUNGNAM"
  | "JEONBUK"
  | "JEONNAM"
  | "GYEONGBUK"
  | "GYEONGNAM"
  | "JEJU"
  | "OTHER";

export type ManifestTarget = {
  complex_id: string;
  region: RegionCode;
  coordinate_status: "READY" | "MISSING";
  nearby_status: "READY" | "MISSING" | "NO_NEARBY_SCHOOL";
  school_count: number;
  school_detail_dependency: "NONE" | "CHECK";
  priority: TargetPriority;
  source: "EXISTING_READY" | "LIVING_FOLLOW" | "ALREADY_COMPLETE";
  status: TargetStatus;
};

export type RunnerProgress = {
  version: number;
  started_at: string;
  updated_at: string;
  terminal_state: "RUNNING" | "COMPLETE" | "STOPPED" | "FAILED";
  canonical_total: number;
  existing_ready_total: number;
  living_wait_total: number;
  nearby_processed: number;
  nearby_success: number;
  nearby_no_result: number;
  school_details_processed: number;
  school_details_added: number;
  living_handoff_received: number;
  failed: number;
  retryable: number;
  current_region: RegionCode | null;
  current_complex_id: string | null;
  external_calls: number;
  wave: "EXISTING_READY" | "LIVING_FOLLOW" | "FINAL_SWEEP" | "IDLE_WAIT";
  last_dependency_check_at: string | null;
  last_heartbeat_at: string | null;
  batches_completed: number;
  relation_inserts: number;
  materialization_inserts: number;
  restarts: number;
  final_sweep_done: boolean;
  coverage: {
    national_nearby: number;
    seoul_nearby: number;
    gyeonggi_nearby: number;
    coord_ready: number;
  };
};

export type RunnerLock = {
  pid: number;
  started_at: string;
  hostname: string;
  command: string;
};

export function regionFromSido(sido: string | null | undefined): RegionCode {
  const s = String(sido ?? "");
  if (s.startsWith("서울")) return "SEOUL";
  if (s.startsWith("경기")) return "GYEONGGI";
  if (s.startsWith("인천")) return "INCHEON";
  if (s.startsWith("부산")) return "BUSAN";
  if (s.startsWith("대구")) return "DAEGU";
  if (s.startsWith("대전")) return "DAEJEON";
  if (s.startsWith("광주") || s.startsWith("전남광주")) return "GWANGJU";
  if (s.startsWith("울산")) return "ULSAN";
  if (s.startsWith("세종")) return "SEJONG";
  if (s.startsWith("강원")) return "GANGWON";
  if (s.startsWith("충북") || s.startsWith("충청북")) return "CHUNGBUK";
  if (s.startsWith("충남") || s.startsWith("충청남")) return "CHUNGNAM";
  if (s.startsWith("전북") || s.startsWith("전라북")) return "JEONBUK";
  if (s.startsWith("전남") || s.startsWith("전라남")) return "JEONNAM";
  if (s.startsWith("경북") || s.startsWith("경상북")) return "GYEONGBUK";
  if (s.startsWith("경남") || s.startsWith("경상남")) return "GYEONGNAM";
  if (s.startsWith("제주")) return "JEJU";
  return "OTHER";
}

export function priorityFor(region: RegionCode, source: ManifestTarget["source"]): TargetPriority {
  if (source === "LIVING_FOLLOW") return "P2_LIVING_FOLLOW";
  if (region === "SEOUL") return "P0_SEOUL";
  if (region === "GYEONGGI") return "P1_GYEONGGI";
  return "P3_NATIONAL";
}

const PRIORITY_ORDER: Record<TargetPriority, number> = {
  P0_SEOUL: 0,
  P1_GYEONGGI: 1,
  P2_LIVING_FOLLOW: 2,
  P3_NATIONAL: 3,
  P4_DETAIL: 4,
};

/** Stable ordering: priority → region → complex_id */
export function compareTargets(a: ManifestTarget, b: ManifestTarget): number {
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (p !== 0) return p;
  if (a.region !== b.region) return a.region < b.region ? -1 : 1;
  return a.complex_id < b.complex_id ? -1 : a.complex_id > b.complex_id ? 1 : 0;
}

export function classifyComplex(input: {
  complex_id: string;
  sido: string | null;
  lat: number | null;
  lng: number | null;
  identity_status: string | null;
  stored_version: string | null;
  stored_status: string | null;
  link_count: number;
  livingHandoff?: boolean;
}): ManifestTarget {
  const region = regionFromSido(input.sido);
  const safe = isSafeParcelPoint(input.lat, input.lng, input.identity_status);
  if (!safe || input.lat == null || input.lng == null) {
    return {
      complex_id: input.complex_id,
      region,
      coordinate_status: "MISSING",
      nearby_status: "MISSING",
      school_count: 0,
      school_detail_dependency: "NONE",
      priority: priorityFor(region, "LIVING_FOLLOW"),
      source: "LIVING_FOLLOW",
      status: "WAIT_COORDINATE",
    };
  }
  const version = parcelCoordVersion(input.lat, input.lng);
  const action = nearbyDeltaAction({
    safe: true,
    coordVersion: version,
    storedVersion: input.stored_version,
    storedStatus: input.stored_status,
  });
  if (action === "reuse") {
    const noSchool = (input.link_count ?? 0) <= 0 || input.stored_status === "NO_SCHOOLS_WITHIN_RADIUS";
    return {
      complex_id: input.complex_id,
      region,
      coordinate_status: "READY",
      nearby_status: noSchool ? "NO_NEARBY_SCHOOL" : "READY",
      school_count: input.link_count ?? 0,
      school_detail_dependency: "NONE",
      priority: priorityFor(region, "ALREADY_COMPLETE"),
      source: "ALREADY_COMPLETE",
      status: noSchool ? "NO_NEARBY_SCHOOL" : "COMPLETE",
    };
  }
  const source = input.livingHandoff ? "LIVING_FOLLOW" : "EXISTING_READY";
  return {
    complex_id: input.complex_id,
    region,
    coordinate_status: "READY",
    nearby_status: "MISSING",
    school_count: 0,
    school_detail_dependency: "NONE",
    priority: priorityFor(region, source),
    source,
    status: "READY_NEARBY",
  };
}

export function emptyProgress(now: string, baselines?: Partial<RunnerProgress>): RunnerProgress {
  return {
    version: RUNNER_VERSION,
    started_at: now,
    updated_at: now,
    terminal_state: "RUNNING",
    canonical_total: baselines?.canonical_total ?? 0,
    existing_ready_total: baselines?.existing_ready_total ?? 0,
    living_wait_total: baselines?.living_wait_total ?? 0,
    nearby_processed: 0,
    nearby_success: 0,
    nearby_no_result: 0,
    school_details_processed: 0,
    school_details_added: 0,
    living_handoff_received: 0,
    failed: 0,
    retryable: 0,
    current_region: null,
    current_complex_id: null,
    external_calls: 0,
    wave: "EXISTING_READY",
    last_dependency_check_at: null,
    last_heartbeat_at: now,
    batches_completed: 0,
    relation_inserts: 0,
    materialization_inserts: 0,
    restarts: baselines?.restarts ?? 0,
    final_sweep_done: false,
    coverage: baselines?.coverage ?? {
      national_nearby: 0,
      seoul_nearby: 0,
      gyeonggi_nearby: 0,
      coord_ready: 0,
    },
  };
}

export function materializeNearbyLinks(input: {
  lat: number;
  lng: number;
  grid: Map<string, NearbySchoolPoint[]>;
  radiusM?: number;
}) {
  const links = linksWithinRadius(
    { lat: input.lat, lng: input.lng },
    schoolsNearCell(input.grid, input.lat, input.lng),
    input.radiusM ?? NEARBY_RADIUS_M,
  );
  for (const link of links) {
    if (!Number.isFinite(link.distanceM) || link.distanceM < 0 || link.distanceM > NEARBY_RADIUS_M) {
      throw new Error(`invalid distance ${link.distanceM} for ${link.code}`);
    }
  }
  return links;
}

export function buildOperatingSchoolGrid(points: NearbySchoolPoint[]) {
  return buildSchoolGrid(points);
}

export {
  parcelCoordVersion,
  nearbyDeltaAction,
  isSafeParcelPoint,
  DISTANCE_BASIS,
  NEARBY_CLASSIFICATION,
  NEARBY_RADIUS_M,
};
