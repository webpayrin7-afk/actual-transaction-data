/**
 * NEIS OpenAPI — nearby schools for Phase 8.1 pilot.
 * Classification: NEARBY_SCHOOL only (not assigned / not district).
 */

import {
  JAMSIL_ELS_MAP_PILOT,
  SCHOOL_CATCHMENT_AUDIT,
} from "@/lib/nearby-map/jamsil-els-pilot";
import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";

export type NearbySchool = {
  id: string;
  name: string;
  schoolType: "초등학교" | "중학교" | "고등학교" | "기타";
  fondType: string | null;
  address: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  classification: "NEARBY_SCHOOL";
  source: "NEIS";
};

export type NearbySchoolsResult = {
  ok: boolean;
  schools: NearbySchool[];
  elementary: NearbySchool[];
  middle: NearbySchool[];
  high: NearbySchool[];
  note: string;
  catchment: typeof SCHOOL_CATCHMENT_AUDIT;
};

function neisKey(): string | null {
  return process.env.NEIS_API_KEY?.trim() || null;
}

function vworldKey(): string | null {
  return (
    process.env.VWORLD_API_KEY?.trim() ||
    process.env.VWORLD_KEY?.trim() ||
    null
  );
}

type NeisRow = {
  SCHUL_NM?: string;
  SCHUL_KND_SC_NM?: string;
  FOND_SC_NM?: string;
  ORG_RDNMA?: string;
  ORG_RDNDA?: string;
  LCTN_SC_NM?: string;
  JU_ORG_NM?: string;
  SD_SCHUL_CODE?: string;
  ATPT_OFCDC_SC_CODE?: string;
};

function classifyType(raw: string | undefined): NearbySchool["schoolType"] {
  const s = String(raw ?? "");
  if (s.includes("초등")) return "초등학교";
  if (s.includes("중학")) return "중학교";
  if (s.includes("고등")) return "고등학교";
  return "기타";
}

function inScope(row: NeisRow): boolean {
  const addr = `${row.ORG_RDNMA ?? ""} ${row.ORG_RDNDA ?? ""} ${row.JU_ORG_NM ?? ""} ${row.LCTN_SC_NM ?? ""}`;
  if (!addr.includes(JAMSIL_ELS_MAP_PILOT.nearbyGu)) return false;
  return JAMSIL_ELS_MAP_PILOT.nearbyDongs.some((d) => addr.includes(d));
}

async function fetchNeisPage(pIndex: number): Promise<NeisRow[]> {
  const key = neisKey();
  if (!key) return [];
  const url = new URL("https://open.neis.go.kr/hub/schoolInfo");
  url.searchParams.set("KEY", key);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", String(pIndex));
  url.searchParams.set("pSize", "100");
  url.searchParams.set("ATPT_OFCDC_SC_CODE", JAMSIL_ELS_MAP_PILOT.ofcdcCode);

  const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`NEIS HTTP ${res.status}`);
  const json = (await res.json()) as {
    schoolInfo?: Array<{ head?: unknown; row?: NeisRow[] }>;
    RESULT?: { CODE?: string; MESSAGE?: string };
  };
  if (json.RESULT?.CODE && json.RESULT.CODE !== "INFO-000") {
    throw new Error(`NEIS ${json.RESULT.CODE}: ${json.RESULT.MESSAGE ?? ""}`);
  }
  return json.schoolInfo?.find((b) => Array.isArray(b.row))?.row ?? [];
}

async function geocodeAddress(
  address: string,
  key: string
): Promise<LatLng | null> {
  const url = new URL("https://api.vworld.kr/req/address");
  url.searchParams.set("service", "address");
  url.searchParams.set("request", "getcoord");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("crs", "epsg:4326");
  url.searchParams.set("address", address);
  url.searchParams.set("type", "road");
  url.searchParams.set("format", "json");
  url.searchParams.set("key", key);
  try {
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      response?: { result?: { point?: { x?: string; y?: string } } };
    };
    const lng = Number(json.response?.result?.point?.x);
    const lat = Number(json.response?.result?.point?.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

export async function loadNearbySchools(
  center: LatLng
): Promise<NearbySchoolsResult> {
  const catchment = SCHOOL_CATCHMENT_AUDIT;
  if (!neisKey()) {
    return {
      ok: false,
      schools: [],
      elementary: [],
      middle: [],
      high: [],
      note: "NEIS_API_KEY not configured",
      catchment,
    };
  }
  const vw = vworldKey();
  if (!vw) {
    return {
      ok: false,
      schools: [],
      elementary: [],
      middle: [],
      high: [],
      note: "VWORLD_API_KEY required to map NEIS school addresses to coordinates",
      catchment,
    };
  }

  try {
    const pages: NeisRow[] = [];
    for (let p = 1; p <= 8; p++) {
      const rows = await fetchNeisPage(p);
      if (!rows.length) break;
      pages.push(...rows);
      if (rows.length < 100) break;
    }

    const scoped = pages.filter(inScope);
    const out: NearbySchool[] = [];

    for (const row of scoped) {
      const name = String(row.SCHUL_NM ?? "").trim();
      if (!name) continue;
      const address = [row.ORG_RDNMA, row.ORG_RDNDA]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!address) continue;
      const coord = await geocodeAddress(address, vw);
      if (!coord) continue;
      const distanceM = haversineMeters(center, coord);
      if (distanceM > JAMSIL_ELS_MAP_PILOT.radiusM.school) continue;
      out.push({
        id: `neis-${row.ATPT_OFCDC_SC_CODE ?? "B10"}-${row.SD_SCHUL_CODE ?? name}`,
        name,
        schoolType: classifyType(row.SCHUL_KND_SC_NM),
        fondType: row.FOND_SC_NM ? String(row.FOND_SC_NM) : null,
        address,
        lat: coord.lat,
        lng: coord.lng,
        distanceM,
        classification: "NEARBY_SCHOOL",
        source: "NEIS",
      });
    }

    out.sort((a, b) => {
      const seed = (n: string) =>
        JAMSIL_ELS_MAP_PILOT.neisNameSeeds.some((s) => n.includes(s)) ? 0 : 1;
      const s = seed(a.name) - seed(b.name);
      if (s !== 0) return s;
      return a.distanceM - b.distanceM;
    });

    const schools = out.slice(0, 24);
    return {
      ok: schools.length > 0,
      schools,
      elementary: schools.filter((s) => s.schoolType === "초등학교"),
      middle: schools.filter((s) => s.schoolType === "중학교"),
      high: schools.filter((s) => s.schoolType === "고등학교"),
      note:
        schools.length > 0
          ? `NEIS schoolInfo + VWorld geocode · ${schools.length} NEARBY_SCHOOL within ${JAMSIL_ELS_MAP_PILOT.radiusM.school}m`
          : "No geocoded NEIS schools in scoped dongs within radius",
      catchment,
    };
  } catch (e) {
    return {
      ok: false,
      schools: [],
      elementary: [],
      middle: [],
      high: [],
      note: e instanceof Error ? e.message : String(e),
      catchment,
    };
  }
}
