/**
 * Seoul complex canonical coordinate DRY-RUN (no Production writes).
 *
 * Sources (priority):
 *  A) apt_complex_master lat/lng when valid
 *  B) product mapAnchor fixtures (잠실엘스)
 *  C) commerce stage-c2 nominatim cache — PILOT_ONLY, NOT write-gate-eligible
 *
 * Does NOT mass-call NAVER/VWorld (Hub geocode REST 401; VWorld key absent).
 * Composes canonical jibun addresses for future address-based geocode.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { haversineMeters } from "../../src/lib/complex-detail/geo";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";
import { isCoordinateWriteGateEligible } from "../../src/lib/complex-coordinates/types";
import type { CoordinateResolutionStatus } from "../../src/lib/complex-coordinates/types";

const OUT = process.argv[2] || "/tmp/complex-coordinate-out";
const SOURCE_VERSION = "coord-dry-run-2026-09-18";

/** Seoul bbox sanity (loose). */
const SEOUL_BBOX = { minLat: 37.42, maxLat: 37.72, minLng: 126.75, maxLng: 127.22 };

type Status = CoordinateResolutionStatus;

type Candidate = {
  complex_id: string;
  apt_name: string;
  sigungu: string | null;
  legal_dong_name: string | null;
  lawd_cd: string | null;
  jibun: string | null;
  road_address: string | null;
  input_address: string | null;
  address_type: "road" | "jibun_composed" | null;
  lat: number | null;
  lng: number | null;
  source: string | null;
  source_id: string | null;
  resolution_method: string | null;
  confidence: "high" | "medium" | "low" | "none";
  status: Status;
  gate_eligible: boolean;
  notes: string[];
  sources_considered: Array<{
    source: string;
    lat: number;
    lng: number;
    confidence: string;
  }>;
};

function inSeoulBbox(lat: number, lng: number): boolean {
  return (
    lat >= SEOUL_BBOX.minLat &&
    lat <= SEOUL_BBOX.maxLat &&
    lng >= SEOUL_BBOX.minLng &&
    lng <= SEOUL_BBOX.maxLng
  );
}

function composeJibunAddress(c: {
  sido: string | null;
  sigungu: string | null;
  legal_dong_name: string | null;
  jibun: string | null;
}): string | null {
  if (!c.sigungu || !c.legal_dong_name || !c.jibun) return null;
  const sido = c.sido?.includes("서울") ? "서울특별시" : c.sido || "서울특별시";
  return `${sido} ${c.sigungu} ${c.legal_dong_name} ${c.jibun}`.replace(/\s+/g, " ").trim();
}

function loadProductAnchors(): Map<string, { lat: number; lng: number; source: string }> {
  const m = new Map<string, { lat: number; lng: number; source: string }>();
  m.set(JAMSIL_ELS_CANONICAL_CENTER.complexId, {
    lat: JAMSIL_ELS_CANONICAL_CENTER.lat,
    lng: JAMSIL_ELS_CANONICAL_CENTER.lng,
    source: JAMSIL_ELS_CANONICAL_CENTER.coordinateSource,
  });
  return m;
}

function loadCommerceC2Nominatim(): Map<
  string,
  { lat: number; lng: number; query: string; matched: string }
> {
  const path = "data/poc/commerce/stage-c2-coordinate-cache.json";
  const m = new Map<
    string,
    { lat: number; lng: number; query: string; matched: string }
  >();
  if (!existsSync(path)) return m;
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    items?: Array<{
      complex_id: string;
      lat: number;
      lng: number;
      query?: string;
      matched?: string;
    }>;
  };
  for (const it of doc.items || []) {
    if (Number.isFinite(it.lat) && Number.isFinite(it.lng)) {
      m.set(it.complex_id, {
        lat: it.lat,
        lng: it.lng,
        query: it.query || "",
        matched: it.matched || "",
      });
    }
  }
  return m;
}

function pickStatus(params: {
  sources: Array<{ source: string; lat: number; lng: number; confidence: string }>;
  sigungu: string | null;
}): { status: Status; lat: number | null; lng: number | null; notes: string[] } {
  const notes: string[] = [];
  const { sources } = params;
  if (sources.length === 0) {
    return { status: "SOURCE_NO_MATCH", lat: null, lng: null, notes };
  }

  // Prefer high-confidence sources
  const high = sources.filter((s) => s.confidence === "high");
  const pool = high.length ? high : sources;

  if (pool.length >= 2) {
    const a = pool[0]!;
    const b = pool[1]!;
    const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
    notes.push(`multi_source_delta_m=${Math.round(d)}`);
    if (d <= 80) {
      const lat = (a.lat + b.lat) / 2;
      const lng = (a.lng + b.lng) / 2;
      if (!inSeoulBbox(lat, lng)) {
        return { status: "OUTSIDE_EXPECTED_REGION", lat, lng, notes };
      }
      return {
        status:
          high.length >= 2 ? "MULTI_SOURCE_CONFIRMED" : "AMBIGUOUS",
        lat,
        lng,
        notes,
      };
    }
    return { status: "AMBIGUOUS", lat: a.lat, lng: a.lng, notes };
  }

  const one = pool[0]!;
  if (!inSeoulBbox(one.lat, one.lng)) {
    return {
      status: "OUTSIDE_EXPECTED_REGION",
      lat: one.lat,
      lng: one.lng,
      notes,
    };
  }
  if (one.confidence === "high") {
    return {
      status: "SINGLE_SOURCE_HIGH_CONFIDENCE",
      lat: one.lat,
      lng: one.lng,
      notes,
    };
  }
  if (one.confidence === "low") {
    return {
      status: "PILOT_LOW_CONFIDENCE",
      lat: one.lat,
      lng: one.lng,
      notes: [...notes, "nominatim_or_pilot_only_not_gate_eligible"],
    };
  }
  return {
    status: "PILOT_LOW_CONFIDENCE",
    lat: one.lat,
    lng: one.lng,
    notes,
  };
}

async function main() {
  if (process.argv.includes("--write")) {
    console.error("WRITE GUARD: coordinate dry-run refuses --write");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const rs = await db.execute(`
    SELECT complex_id, apt_name, sido, sigungu, lawd_cd, legal_dong_name, jibun,
           road_address, latitude, longitude, identity_status
    FROM apt_complex_master
    WHERE sido LIKE '%서울%' OR lawd_cd LIKE '11%' OR sido_code = '11'
    ORDER BY complex_id
  `);

  const product = loadProductAnchors();
  const nominatim = loadCommerceC2Nominatim();

  const counts: Record<string, number> = {};
  const bump = (s: string) => {
    counts[s] = (counts[s] || 0) + 1;
  };

  const candidates: Candidate[] = [];
  const unresolved: Candidate[] = [];
  let gateEligible = 0;
  const coordKeyCount = new Map<string, number>();

  for (const row of rs.rows) {
    const complex_id = String(row.complex_id);
    const apt_name = String(row.apt_name ?? "");
    const sigungu = row.sigungu == null ? null : String(row.sigungu);
    const legal_dong_name =
      row.legal_dong_name == null ? null : String(row.legal_dong_name);
    const lawd_cd = row.lawd_cd == null ? null : String(row.lawd_cd);
    const jibun = row.jibun == null ? null : String(row.jibun);
    const road_address =
      row.road_address == null || String(row.road_address).trim() === ""
        ? null
        : String(row.road_address);
    const sido = row.sido == null ? null : String(row.sido);

    const composed = composeJibunAddress({
      sido,
      sigungu,
      legal_dong_name,
      jibun,
    });
    const input_address = road_address || composed;
    const address_type: Candidate["address_type"] = road_address
      ? "road"
      : composed
        ? "jibun_composed"
        : null;

    const considered: Candidate["sources_considered"] = [];

    const mlat = row.latitude == null ? NaN : Number(row.latitude);
    const mlng = row.longitude == null ? NaN : Number(row.longitude);
    if (
      Number.isFinite(mlat) &&
      Number.isFinite(mlng) &&
      !(mlat === 0 && mlng === 0)
    ) {
      considered.push({
        source: "apt_complex_master",
        lat: mlat,
        lng: mlng,
        confidence: "high",
      });
    }

    const pa = product.get(complex_id);
    if (pa) {
      considered.push({
        source: "product_map_anchor",
        lat: pa.lat,
        lng: pa.lng,
        confidence: "high",
      });
    }

    const nom = nominatim.get(complex_id);
    if (nom) {
      considered.push({
        source: "commerce_c2_nominatim_pilot",
        lat: nom.lat,
        lng: nom.lng,
        confidence: "low",
      });
    }

    let status: Status;
    let lat: number | null = null;
    let lng: number | null = null;
    let notes: string[] = [];

    if (!input_address) {
      status = "ADDRESS_INCOMPLETE";
      notes.push("no road or composable jibun");
    } else {
      const picked = pickStatus({ sources: considered, sigungu });
      status = picked.status;
      lat = picked.lat;
      lng = picked.lng;
      notes = picked.notes;
      if (considered.length === 0) {
        status = "SOURCE_NO_MATCH";
        notes.push(
          "jibun_address_composable_but_no_coordinate_source; naver_geocode_rest=401; vworld_key=absent; mass_geocode_forbidden",
        );
      }
    }

    // Gu consistency soft check when we have a lat/lng from nominatim matched string
    if (lat != null && lng != null && nom && sigungu) {
      if (nom.matched && !nom.matched.includes(sigungu.replace(/\s/g, ""))) {
        // matched string may use same gu
        if (!nom.matched.includes(sigungu)) {
          notes.push("nominatim_matched_string_gu_mismatch_suspect");
          if (status === "PILOT_LOW_CONFIDENCE") {
            status = "AMBIGUOUS";
          }
        }
      }
    }

    const gate_eligible = isCoordinateWriteGateEligible(status);
    if (gate_eligible) gateEligible += 1;
    bump(status);

    if (lat != null && lng != null) {
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      coordKeyCount.set(key, (coordKeyCount.get(key) || 0) + 1);
    }

    const best = considered
      .slice()
      .sort((a, b) => {
        const rank = (c: string) => (c === "high" ? 0 : c === "medium" ? 1 : 2);
        return rank(a.confidence) - rank(b.confidence);
      })[0];

    const cand: Candidate = {
      complex_id,
      apt_name,
      sigungu,
      legal_dong_name,
      lawd_cd,
      jibun,
      road_address,
      input_address,
      address_type,
      lat,
      lng,
      source: best?.source ?? null,
      source_id: best?.source ?? null,
      resolution_method: best
        ? `tier_${best.confidence}_${best.source}`
        : "none",
      confidence:
        best?.confidence === "high"
          ? "high"
          : best?.confidence === "medium"
            ? "medium"
            : best
              ? "low"
              : "none",
      status,
      gate_eligible,
      notes,
      sources_considered: considered,
    };
    candidates.push(cand);
    if (!gate_eligible) unresolved.push(cand);
  }

  // Duplicate coordinate groups (exact 5-decimal)
  const dupGroups = [...coordKeyCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);

  // Samples across districts among gate-eligible + a few unresolved
  const sampleGus = ["강남구", "송파구", "종로구", "마포구", "강서구", "노원구"];
  const samples: Candidate[] = [];
  for (const gu of sampleGus) {
    const hit =
      candidates.find((c) => c.gate_eligible && c.sigungu === gu) ||
      candidates.find((c) => c.sigungu === gu);
    if (hit) samples.push(hit);
  }

  // Jamsil regression
  const jam = candidates.find(
    (c) => c.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId,
  );
  const jamDiff =
    jam?.lat != null && jam?.lng != null
      ? haversineMeters(
          jam.lat,
          jam.lng,
          JAMSIL_ELS_CANONICAL_CENTER.lat,
          JAMSIL_ELS_CANONICAL_CENTER.lng,
        )
      : null;

  const summary = {
    mode: "dry-run",
    source_version: SOURCE_VERSION,
    generatedAt: new Date().toISOString(),
    production_coordinate_rows_written: 0,
    baseline: {
      total: candidates.length,
      master_both_nonnull: candidates.filter((c) =>
        c.sources_considered.some((s) => s.source === "apt_complex_master"),
      ).length,
      both_null_on_master: candidates.filter(
        (c) =>
          !c.sources_considered.some((s) => s.source === "apt_complex_master"),
      ).length,
      with_road_address: candidates.filter((c) => c.road_address).length,
      with_composable_jibun: candidates.filter(
        (c) => c.address_type === "jibun_composed" || c.road_address,
      ).length,
      note: "Prior school dry-run valid_coords=1 because master lat/lng null citywide; only product mapAnchor override for 잠실엘스.",
    },
    sources: [
      {
        source: "apt_complex_master.lat/lng",
        type: "warehouse",
        coverage: candidates.filter((c) =>
          c.sources_considered.some((s) => s.source === "apt_complex_master"),
        ).length,
        confidence: "high_when_present",
      },
      {
        source: "product_map_anchor (잠실엘스)",
        type: "verified_product_fixture",
        coverage: product.size,
        confidence: "high",
      },
      {
        source: "commerce stage-c2 nominatim cache",
        type: "pilot_fallback",
        coverage: nominatim.size,
        confidence: "low_not_gate_eligible",
      },
      {
        source: "NAVER map-geocode REST",
        type: "external",
        coverage: 0,
        confidence: "n/a",
        note: "probe http=401 subscription required — not used",
      },
      {
        source: "VWorld",
        type: "external",
        coverage: 0,
        confidence: "n/a",
        note: "API key absent in env — not used",
      },
    ],
    external_geocoder_used: false,
    network_calls: 1, // single NAVER probe only
    cache_hits: nominatim.size,
    resolution: {
      total: candidates.length,
      ...Object.fromEntries(
        [
          "CONFIRMED",
          "MULTI_SOURCE_CONFIRMED",
          "SINGLE_SOURCE_HIGH_CONFIDENCE",
          "PILOT_LOW_CONFIDENCE",
          "AMBIGUOUS",
          "ADDRESS_INCOMPLETE",
          "SOURCE_NO_MATCH",
          "MULTIPLE_MATCHES",
          "OUTSIDE_EXPECTED_REGION",
          "INVALID_COORD",
          "ERROR",
        ].map((k) => [k, counts[k] || 0]),
      ),
      gate_eligible: gateEligible,
      usable_coordinate_coverage_pct: Number(
        ((100 * gateEligible) / Math.max(1, candidates.length)).toFixed(4),
      ),
    },
    quality: {
      gu_consistency: "soft_check_on_nominatim_matched_string_only",
      outside_seoul: counts["OUTSIDE_EXPECTED_REGION"] || 0,
      duplicate_coordinate_groups: dupGroups.length,
      duplicate_top: dupGroups.slice(0, 10).map(([k, n]) => ({ coord: k, n })),
      multi_source_disagreements: counts["AMBIGUOUS"] || 0,
      largest_issue:
        "No citywide high-confidence coordinate source without mass geocode; master lat/lng empty; NAVER geocode REST unsubscribed; VWorld key absent.",
    },
    jamsil_els: {
      complex_id: JAMSIL_ELS_CANONICAL_CENTER.complexId,
      old_anchor: {
        lat: JAMSIL_ELS_CANONICAL_CENTER.lat,
        lng: JAMSIL_ELS_CANONICAL_CENTER.lng,
      },
      candidate: jam
        ? { lat: jam.lat, lng: jam.lng, status: jam.status, source: jam.source }
        : null,
      difference_meters: jamDiff == null ? null : Math.round(jamDiff * 100) / 100,
      status: jam?.status ?? null,
      gate_eligible: jam?.gate_eligible ?? false,
      regression: jam?.gate_eligible && (jamDiff ?? 99) < 1 ? "PASS" : "FAIL",
    },
    data_model: {
      canonical_coordinate_location: "apt_complex_master.latitude/longitude (future WRITE)",
      metadata_location:
        "apt_complex_enrichment_state domain=coordinate + optional source_links (draft; not applied)",
      new_tables: [],
      reused_tables: ["apt_complex_master", "apt_complex_source_links", "apt_complex_enrichment_state"],
      migration_drafted: false,
      migration_applied: false,
      note: "Avoid large new schema; store source/confidence via enrichment_state on WRITE phase.",
    },
    samples: samples.map((s) => ({
      complex_id: s.complex_id,
      apt_name: s.apt_name,
      address: s.input_address,
      source: s.source,
      coordinate: s.lat != null ? { lat: s.lat, lng: s.lng } : null,
      status: s.status,
      gate_eligible: s.gate_eligible,
    })),
  };

  writeFileSync(join(OUT, "complex-coordinate-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(OUT, "complex-coordinate-candidates.json"),
    JSON.stringify(
      {
        source_version: SOURCE_VERSION,
        count: candidates.length,
        gate_eligible: gateEligible,
        candidates: candidates.map((c) => ({
          complex_id: c.complex_id,
          lat: c.lat,
          lng: c.lng,
          status: c.status,
          gate_eligible: c.gate_eligible,
          source: c.source,
          input_address: c.input_address,
          confidence: c.confidence,
        })),
      },
      null,
      2,
    ),
  );

  // unresolved CSV
  const lines = [
    "complex_id,apt_name,sigungu,status,input_address,notes",
    ...unresolved.map((c) =>
      [
        c.complex_id,
        JSON.stringify(c.apt_name),
        c.sigungu ?? "",
        c.status,
        JSON.stringify(c.input_address ?? ""),
        JSON.stringify(c.notes.join("|")),
      ].join(","),
    ),
  ];
  writeFileSync(join(OUT, "complex-coordinate-unresolved.csv"), lines.join("\n"));

  writeFileSync(
    join(OUT, "complex-coordinate-sample.json"),
    JSON.stringify({ samples: summary.samples, jamsil_els: summary.jamsil_els }, null, 2),
  );

  // Gate-eligible coords override for school materialization re-dry-run
  const overrides: Record<string, { lat: number; lng: number; source: string }> = {};
  for (const c of candidates) {
    if (c.gate_eligible && c.lat != null && c.lng != null) {
      overrides[c.complex_id] = {
        lat: c.lat,
        lng: c.lng,
        source: c.source || "unknown",
      };
    }
  }
  writeFileSync(
    join(OUT, "complex-coordinate-gate-overrides.json"),
    JSON.stringify(
      { source_version: SOURCE_VERSION, count: Object.keys(overrides).length, overrides },
      null,
      2,
    ),
  );

  // Copy summary/sample into repo poc
  const repoOut = "data/poc/complex-coordinates";
  mkdirSync(repoOut, { recursive: true });
  writeFileSync(
    join(repoOut, "complex-coordinate-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(repoOut, "complex-coordinate-sample.json"),
    JSON.stringify({ samples: summary.samples, jamsil_els: summary.jamsil_els }, null, 2),
  );

  console.log(
    JSON.stringify(
      {
        out: OUT,
        total: candidates.length,
        gate_eligible: gateEligible,
        SOURCE_NO_MATCH: counts["SOURCE_NO_MATCH"] || 0,
        PILOT_LOW_CONFIDENCE: counts["PILOT_LOW_CONFIDENCE"] || 0,
        jamsil: summary.jamsil_els,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
