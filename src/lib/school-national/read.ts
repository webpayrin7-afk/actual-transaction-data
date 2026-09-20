import type { Client } from "@libsql/client";
import { SCHOOLINFO_ATTRIBUTION, SCHOOLINFO_LICENSE } from "./parse";
import { SCHOOL_CATEGORIES } from "./incremental";
import {
  isSafeParcelPoint,
  nearbyReadState,
  parcelCoordVersion,
  type NearbyReadState,
} from "./nearby-delta";

export type SchoolDetailRead = {
  schoolCode: string;
  found: boolean;
  liveSourceCalls: 0;
  attribution: string;
  licenseNote: string;
  school: Record<string, unknown> | null;
  categories: Record<string, {
    disclosureYear: string | null;
    status: string;
    parsed: unknown;
  }>;
};

export async function readSchoolDetail(db: Client, schoolCode: string): Promise<SchoolDetailRead> {
  const master = await db.execute({
    sql: `SELECT school_code, school_name, school_level, establishment_type, gender_type,
            sido, sigungu, address, road_address, lat, lng, status, source, source_as_of,
            coord_status, attribution
          FROM school_master WHERE school_code = ?`,
    args: [schoolCode],
  });
  const current = await db.execute({
    sql: `SELECT c.category, c.disclosure_year, c.snapshot_status, s.parsed_json
          FROM school_snapshot_current c
          JOIN school_detail_snapshots s
            ON s.school_code = c.school_code
           AND s.category = c.category
           AND s.disclosure_year = c.disclosure_year
           AND s.source = c.source
          WHERE c.school_code = ?`,
    args: [schoolCode],
  });
  const byCategory = new Map(current.rows.map((row) => [String(row.category), row]));
  const categories: SchoolDetailRead["categories"] = {};
  for (const category of SCHOOL_CATEGORIES) {
    const row = byCategory.get(category);
    categories[category] = row
      ? {
          disclosureYear: String(row.disclosure_year),
          status: String(row.snapshot_status),
          parsed: JSON.parse(String(row.parsed_json ?? "null")),
        }
      : { disclosureYear: null, status: "POINTER_MISSING", parsed: null };
  }
  return {
    schoolCode,
    found: master.rows.length > 0,
    liveSourceCalls: 0,
    attribution: SCHOOLINFO_ATTRIBUTION,
    licenseNote: SCHOOLINFO_LICENSE,
    school: master.rows[0] ? { ...master.rows[0] } : null,
    categories,
  };
}

export type NearbySchoolRead = {
  complexId: string;
  state: NearbyReadState;
  liveSourceCalls: 0;
  classification: "NEARBY_SCHOOL";
  distanceBasis: "PARCEL_REPRESENTATIVE_POINT";
  coordVersion: string | null;
  radiusM: 1500;
  schools: {
    elementary: NearbySchoolItem[];
    middle: NearbySchoolItem[];
    high: NearbySchoolItem[];
  } | null;
};

export type NearbySchoolItem = {
  schoolCode: string;
  schoolName: string;
  distanceM: number;
  rank: number;
};

export async function readNearbySchools(db: Client, complexId: string): Promise<NearbySchoolRead> {
  const complex = await db.execute({
    sql: `SELECT latitude, longitude, identity_status
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  const row = complex.rows[0];
  const lat = row?.latitude == null ? null : Number(row.latitude);
  const lng = row?.longitude == null ? null : Number(row.longitude);
  const identity = row?.identity_status == null ? null : String(row.identity_status);
  const safe = isSafeParcelPoint(lat, lng, identity);
  const currentVersion = safe && lat != null && lng != null ? parcelCoordVersion(lat, lng) : null;
  const material = await db.execute({
    sql: `SELECT coord_version, link_count, status
          FROM complex_nearby_materialization WHERE complex_id = ?`,
    args: [complexId],
  });
  const stored = material.rows[0];
  const storedVersion = stored ? String(stored.coord_version) : null;
  const linkCount = stored ? Number(stored.link_count) : null;
  const state = nearbyReadState({
    safe,
    storedVersion: stored?.status === "BUILDING" ? null : storedVersion,
    currentVersion,
    linkCount,
  });
  const base = {
    complexId,
    state,
    liveSourceCalls: 0 as const,
    classification: "NEARBY_SCHOOL" as const,
    distanceBasis: "PARCEL_REPRESENTATIVE_POINT" as const,
    coordVersion: state === "NO_COORDINATE" ? null : currentVersion,
    radiusM: 1500 as const,
    schools: null,
  };
  if (state !== "READY" && state !== "NO_SCHOOLS_WITHIN_RADIUS") return base;
  if (state === "NO_SCHOOLS_WITHIN_RADIUS") {
    return { ...base, schools: { elementary: [], middle: [], high: [] } };
  }
  const links = await db.execute({
    sql: `SELECT n.school_code, m.school_name, n.school_level, n.distance_m, n.rank_by_distance
          FROM complex_nearby_schools n
          JOIN school_master m ON m.school_code = n.school_code
          WHERE n.complex_id = ?
          ORDER BY n.school_level, n.rank_by_distance`,
    args: [complexId],
  });
  const schools = { elementary: [] as NearbySchoolItem[], middle: [] as NearbySchoolItem[], high: [] as NearbySchoolItem[] };
  for (const link of links.rows) {
    const level = String(link.school_level);
    const item = {
      schoolCode: String(link.school_code),
      schoolName: String(link.school_name),
      distanceM: Number(link.distance_m),
      rank: Number(link.rank_by_distance),
    };
    if (level === "elementary" || level === "middle" || level === "high") schools[level].push(item);
  }
  return { ...base, schools };
}
