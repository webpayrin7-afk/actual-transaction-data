import type { Client } from "@libsql/client";
import {
  selectEnrichmentCandidates,
  upsertEnrichmentState,
  type EnrichmentCandidateMode,
} from "@/lib/unit-type/enrichment";

/** GEO enrichment data_version for this foundation path. */
export const GEO_DATA_VERSION = 1;

export type GeoInputClass =
  | "GEO-INPUT-READY"
  | "GEO-INPUT-AMBIGUOUS"
  | "GEO-INPUT-UNRESOLVED";

export type GeoMasterRow = {
  complexId: string;
  aptName: string;
  aptNameNorm: string;
  sido: string | null;
  sidoCode: string | null;
  sigungu: string | null;
  lawdCd: string;
  legalDongName: string | null;
  bjdongCd: string | null;
  jibun: string | null;
  roadAddress: string | null;
  latitude: number | null;
  longitude: number | null;
};

export function mapGeoMasterRow(r: Record<string, unknown>): GeoMasterRow {
  return {
    complexId: String(r.complex_id),
    aptName: String(r.apt_name ?? ""),
    aptNameNorm: String(r.apt_name_norm ?? ""),
    sido: r.sido == null ? null : String(r.sido),
    sidoCode: r.sido_code == null ? null : String(r.sido_code),
    sigungu: r.sigungu == null ? null : String(r.sigungu),
    lawdCd: String(r.lawd_cd ?? ""),
    legalDongName: r.legal_dong_name == null ? null : String(r.legal_dong_name),
    bjdongCd: r.bjdong_cd == null ? null : String(r.bjdong_cd),
    jibun: r.jibun == null ? null : String(r.jibun),
    roadAddress: r.road_address == null ? null : String(r.road_address),
    latitude: r.latitude == null ? null : Number(r.latitude),
    longitude: r.longitude == null ? null : Number(r.longitude),
  };
}

/**
 * Deterministic parcel query from master identity.
 * Prefer road_address when present; else legal dong + jibun.
 * Never uses apt_name alone.
 */
export function buildGeoQuery(row: GeoMasterRow): {
  inputClass: GeoInputClass;
  query: string | null;
  reasonCode: string | null;
} {
  const lawdOk = /^\d{5}$/.test(row.lawdCd ?? "");
  const bjdongOk = /^\d{5}$/.test(row.bjdongCd ?? "");
  const jibun = (row.jibun ?? "").trim();
  const road = (row.roadAddress ?? "").trim();

  if (!lawdOk || !bjdongOk) {
    return {
      inputClass: "GEO-INPUT-UNRESOLVED",
      query: null,
      reasonCode: "MISSING_ADMIN_CODES",
    };
  }
  if (!jibun && !road) {
    return {
      inputClass: "GEO-INPUT-UNRESOLVED",
      query: null,
      reasonCode: "MISSING_PARCEL_OR_ROAD",
    };
  }

  const jibunOk = /^[0-9]+(-[0-9]+)?$/.test(jibun);
  if (jibun && !jibunOk && !road) {
    return {
      inputClass: "GEO-INPUT-AMBIGUOUS",
      query: null,
      reasonCode: "MALFORMED_JIBUN",
    };
  }

  if (road) {
    return {
      inputClass: "GEO-INPUT-READY",
      query: road,
      reasonCode: null,
    };
  }

  const dong = (row.legalDongName ?? "").trim();
  if (!dong) {
    return {
      inputClass: "GEO-INPUT-AMBIGUOUS",
      query: null,
      reasonCode: "MISSING_LEGAL_DONG_NAME",
    };
  }

  const parts = [
    (row.sido ?? "").trim(),
    (row.sigungu ?? "").trim(),
    dong,
    jibun,
  ].filter(Boolean);

  return {
    inputClass: "GEO-INPUT-READY",
    query: parts.join(" "),
    reasonCode: null,
  };
}

export async function loadGeoMasterRows(
  db: Client,
  complexIds: string[],
): Promise<GeoMasterRow[]> {
  if (complexIds.length === 0) return [];
  const res = await db.execute({
    sql: `
      SELECT complex_id, apt_name, apt_name_norm, sido, sido_code, sigungu,
             lawd_cd, legal_dong_name, bjdong_cd, jibun, road_address,
             latitude, longitude
      FROM apt_complex_master
      WHERE complex_id IN (${complexIds.map(() => "?").join(",")})
    `,
    args: complexIds,
  });
  return res.rows.map((row) => mapGeoMasterRow(row as Record<string, unknown>));
}

/** Seoul / Gyeonggi plausible WGS84 bounds (loose). */
export function coordsInSeoulGyeonggiBounds(
  lat: number,
  lng: number,
): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= 36.8 && lat <= 38.4 && lng >= 126.3 && lng <= 127.9;
}

export type GeoProviderResult = {
  latitude: number;
  longitude: number;
  provider: string;
  rawLabel?: string;
};

export type GeoProvider = {
  id: string;
  geocode(query: string): Promise<GeoProviderResult | null>;
};

/**
 * Resolve configured GEO provider from env.
 * Returns null when no usable key/source is configured.
 */
export function resolveGeoProvider(
  env: NodeJS.ProcessEnv = process.env,
): GeoProvider | null {
  const vworld = (env.VWORLD_API_KEY ?? env.VWORLD_KEY)?.trim();
  if (vworld) {
    return {
      id: "vworld",
      async geocode(query: string) {
        const url =
          "https://api.vworld.kr/req/address?" +
          new URLSearchParams({
            service: "address",
            request: "getcoord",
            version: "2.0",
            crs: "epsg:4326",
            refine: "true",
            simple: "true",
            format: "json",
            type: "parcel",
            address: query,
            key: vworld,
          }).toString();
        const res = await fetch(url);
        if (!res.ok) return null;
        const body = (await res.json()) as {
          response?: {
            status?: string;
            result?: { point?: { x?: string; y?: string } };
          };
        };
        if (body.response?.status !== "OK") return null;
        const x = Number(body.response?.result?.point?.x);
        const y = Number(body.response?.result?.point?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { latitude: y, longitude: x, provider: "vworld" };
      },
    };
  }

  const kakao = (env.KAKAO_REST_API_KEY ?? env.KAKAO_API_KEY)?.trim();
  if (kakao) {
    return {
      id: "kakao",
      async geocode(query: string) {
        const url =
          "https://dapi.kakao.com/v2/local/search/address.json?" +
          new URLSearchParams({ query }).toString();
        const res = await fetch(url, {
          headers: { Authorization: `KakaoAK ${kakao}` },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          documents?: Array<{
            y?: string;
            x?: string;
            address_name?: string;
          }>;
        };
        const doc = body.documents?.[0];
        if (!doc) return null;
        const lat = Number(doc.y);
        const lng = Number(doc.x);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return {
          latitude: lat,
          longitude: lng,
          provider: "kakao",
          rawLabel: doc.address_name,
        };
      },
    };
  }

  return null;
}

export type GeoRunOptions = {
  dataVersion?: number;
  mode?: EnrichmentCandidateMode;
  limit?: number;
  complexIds?: string[];
  /** When false (default), no master/enrichment writes. */
  write?: boolean;
  provider?: GeoProvider | null;
  forceAll?: boolean;
};

export type GeoRunAggregate = {
  provider: string | null;
  write: boolean;
  dataVersion: number;
  mode: EnrichmentCandidateMode;
  candidates: number;
  attempted: number;
  resolved: number;
  unresolved: number;
  failed: number;
  skippedNoProvider: number;
  skippedAlreadyHaveCoords: number;
  inputReady: number;
  inputAmbiguous: number;
  inputUnresolved: number;
  sanityIssues: number;
  duplicateCoordPairs: number;
  writesMaster: number;
  writesState: number;
};

/**
 * GEO enrichment runner — batched, resumable, idempotent.
 * Default is dry-run (write=false). Does not invent complex_id.
 */
export async function runGeoEnrichment(
  db: Client,
  options: GeoRunOptions = {},
): Promise<GeoRunAggregate> {
  const dataVersion = options.dataVersion ?? GEO_DATA_VERSION;
  const mode = options.mode ?? "missing-only";
  const write = options.write === true;
  const provider =
    options.provider === undefined ? resolveGeoProvider() : options.provider;

  const candidateIds = await selectEnrichmentCandidates(db, {
    domain: "GEO",
    dataVersion,
    mode,
    limit: options.limit ?? 50,
    complexIds: options.complexIds,
    forceAll: options.forceAll,
  });

  const rows = await loadGeoMasterRows(db, candidateIds);
  const agg: GeoRunAggregate = {
    provider: provider?.id ?? null,
    write,
    dataVersion,
    mode,
    candidates: rows.length,
    attempted: 0,
    resolved: 0,
    unresolved: 0,
    failed: 0,
    skippedNoProvider: 0,
    skippedAlreadyHaveCoords: 0,
    inputReady: 0,
    inputAmbiguous: 0,
    inputUnresolved: 0,
    sanityIssues: 0,
    duplicateCoordPairs: 0,
    writesMaster: 0,
    writesState: 0,
  };

  const coordKeyCount = new Map<string, number>();

  for (const row of rows) {
    if (row.latitude != null && row.longitude != null) {
      agg.skippedAlreadyHaveCoords += 1;
      if (write) {
        await upsertEnrichmentState(db, {
          complexId: row.complexId,
          domain: "GEO",
          status: "READY",
          reasonCode: "COORDS_ALREADY_PRESENT",
          dataVersion,
        });
        agg.writesState += 1;
      }
      continue;
    }

    const built = buildGeoQuery(row);
    if (built.inputClass === "GEO-INPUT-READY") agg.inputReady += 1;
    else if (built.inputClass === "GEO-INPUT-AMBIGUOUS") agg.inputAmbiguous += 1;
    else agg.inputUnresolved += 1;

    if (built.inputClass !== "GEO-INPUT-READY" || !built.query) {
      agg.unresolved += 1;
      if (write) {
        await upsertEnrichmentState(db, {
          complexId: row.complexId,
          domain: "GEO",
          status: "UNRESOLVED",
          reasonCode: built.reasonCode ?? built.inputClass,
          dataVersion,
        });
        agg.writesState += 1;
      }
      continue;
    }

    if (!provider) {
      agg.skippedNoProvider += 1;
      continue;
    }

    agg.attempted += 1;
    try {
      const hit = await provider.geocode(built.query);
      if (!hit) {
        agg.unresolved += 1;
        if (write) {
          await upsertEnrichmentState(db, {
            complexId: row.complexId,
            domain: "GEO",
            status: "UNRESOLVED",
            reasonCode: "PROVIDER_NO_HIT",
            dataVersion,
          });
          agg.writesState += 1;
        }
        continue;
      }

      if (!coordsInSeoulGyeonggiBounds(hit.latitude, hit.longitude)) {
        agg.sanityIssues += 1;
        agg.failed += 1;
        if (write) {
          await upsertEnrichmentState(db, {
            complexId: row.complexId,
            domain: "GEO",
            status: "FAILED",
            reasonCode: "OUT_OF_BOUNDS",
            dataVersion,
          });
          agg.writesState += 1;
        }
        continue;
      }

      const key = `${hit.latitude.toFixed(5)},${hit.longitude.toFixed(5)}`;
      coordKeyCount.set(key, (coordKeyCount.get(key) ?? 0) + 1);

      agg.resolved += 1;
      if (write) {
        await db.execute({
          sql: `
            UPDATE apt_complex_master
            SET latitude = ?, longitude = ?, updated_at = ?
            WHERE complex_id = ?
              AND latitude IS NULL
              AND longitude IS NULL
          `,
          args: [
            hit.latitude,
            hit.longitude,
            new Date().toISOString(),
            row.complexId,
          ],
        });
        agg.writesMaster += 1;
        await upsertEnrichmentState(db, {
          complexId: row.complexId,
          domain: "GEO",
          status: "READY",
          reasonCode: `PROVIDER:${hit.provider}`,
          dataVersion,
        });
        agg.writesState += 1;
      }
    } catch {
      agg.failed += 1;
      if (write) {
        await upsertEnrichmentState(db, {
          complexId: row.complexId,
          domain: "GEO",
          status: "FAILED",
          reasonCode: "PROVIDER_ERROR",
          dataVersion,
        });
        agg.writesState += 1;
      }
    }
  }

  for (const n of coordKeyCount.values()) {
    if (n > 1) agg.duplicateCoordPairs += n;
  }

  return agg;
}
