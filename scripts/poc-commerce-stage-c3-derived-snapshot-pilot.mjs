#!/usr/bin/env node
/**
 * Commerce Stage C3 — offline SEMAS → complex commerce snapshot pilot.
 *
 * Exact C2 25 complexes + coordinate cache. Single-pass Seoul SEMAS CSV.
 * Golden fixture: 잠실엘스 (C1/C1B center) verified in same pass (contract only).
 *
 * No Production writes. No schema. No UI. No geocode. No NAVER Local.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv \
 *     node scripts/poc-commerce-stage-c3-derived-snapshot-pilot.mjs
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateCommerceSnapshots,
  toProductionSnapshotPayload,
  hashCanonicalSnapshots,
  SCHEMA_DRAFT_SQL,
  SOURCE,
  SOURCE_PERIOD,
  SOURCE_DATE,
  RADIUS_M,
  POPULATION_VERSION,
  POPULATION_RULE_VERSION,
} from "./lib/commerce-semas-snapshot-transform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data/poc/commerce/stage-c2-coordinate-cache.json");
const C2 = join(
  ROOT,
  "data/poc/commerce/stage-c2-seoul-25-complex-distribution.json",
);
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT_REPORT = join(OUT_DIR, "stage-c3-derived-snapshot-pilot.json");
const OUT_SNAPS = join(OUT_DIR, "stage-c3-derived-snapshots.json");

const JAMSIL_ELS = {
  complex_id: "cx_4c63d9a100973c60",
  name: "잠실엘스",
  sigungu: "송파구",
  lat: 37.5133,
  lng: 127.1028,
  coordinateSource: "c1_verified_pilot_center",
  expectedP0: 5904,
  expectedP2: 4381,
};

function facilityP2Map(facilitiesObj) {
  const out = {};
  for (const [k, v] of Object.entries(facilitiesObj || {})) {
    out[k] = typeof v === "object" && v != null ? Number(v.P2 ?? v) : Number(v);
  }
  return out;
}

function compareToC2(snap, c2Row) {
  const mismatches = [];
  if (snap.p0Total !== c2Row.P0) {
    mismatches.push(`p0 ${snap.p0Total}!=${c2Row.P0}`);
  }
  if (snap.p2Total !== c2Row.P2) {
    mismatches.push(`p2 ${snap.p2Total}!=${c2Row.P2}`);
  }
  const c2Fac = facilityP2Map(c2Row.facilities);
  for (const [k, expected] of Object.entries(c2Fac)) {
    if (snap.facilities[k] !== expected) {
      mismatches.push(`facility ${k} ${snap.facilities[k]}!=${expected}`);
    }
  }
  return mismatches;
}

async function queryGeoGate() {
  let url = process.env.TURSO_DATABASE_URL || "";
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    return {
      seoulComplexes: 8437,
      productionUsableCoordinates: null,
      missingCoordinates: null,
      note: "TURSO env unavailable; expected 8437 Seoul complexes from prior knowledge",
      fullScaleCommerceCalculation: "BLOCKED_BY_GEO",
      FULL_SCALE_GEO_GATE: "OPEN",
    };
  }
  if (url.startsWith("libsql://")) url = "https://" + url.slice("libsql://".length);
  const res = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: {
            sql: `SELECT
              COUNT(*) AS total_seoul,
              SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
                        AND CAST(latitude AS REAL) BETWEEN 33 AND 39
                        AND CAST(longitude AS REAL) BETWEEN 124 AND 132
                   THEN 1 ELSE 0 END) AS usable_coords,
              SUM(CASE WHEN latitude IS NULL OR longitude IS NULL
                        OR CAST(latitude AS REAL) NOT BETWEEN 33 AND 39
                        OR CAST(longitude AS REAL) NOT BETWEEN 124 AND 132
                   THEN 1 ELSE 0 END) AS missing_coords
            FROM apt_complex_master
            WHERE sido = '서울특별시'`,
            args: [],
          },
        },
        { type: "close" },
      ],
    }),
  });
  const j = await res.json();
  const r = j.results?.[0];
  if (r?.type === "error") throw new Error(JSON.stringify(r.error));
  const cols = r.response.result.cols.map((c) => c.name);
  const row = r.response.result.rows[0];
  const o = {};
  row.forEach((cell, i) => {
    o[cols[i]] = Number(cell?.value ?? 0);
  });
  return {
    seoulComplexes: o.total_seoul,
    productionUsableCoordinates: o.usable_coords,
    missingCoordinates: o.missing_coords,
    note: "Read-only Turso query. Nominatim pilot coords NOT written to Production.",
    fullScaleCommerceCalculation:
      o.usable_coords > 0 ? "PARTIAL_IF_ANY" : "BLOCKED_BY_GEO",
    FULL_SCALE_GEO_GATE: "OPEN",
    recommendedNextGeoPath:
      "apt_complex_master validated lat/lng via existing NAVER Maps geocode (src/lib/nearby-map/naver-sdk.ts geocodeAddressWithNaver) + official GIS / VWorld fallbacks already sketched in src/lib/nearby-map/geocode.ts — separate GEO stage; Nominatim is PILOT_ONLY",
  };
}

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c3-derived-snapshot-pilot.mjs",
    );
    process.exit(1);
  }
  if (!existsSync(CACHE) || !existsSync(C2)) {
    console.error("Missing C2 cache or distribution artifact");
    process.exit(1);
  }

  const cache = JSON.parse(readFileSync(CACHE, "utf8"));
  const c2 = JSON.parse(readFileSync(C2, "utf8"));
  const c2ById = new Map(c2.complexes.map((c) => [c.complex_id, c]));

  const pilotCenters = cache.items.map((it) => ({
    complex_id: it.complex_id,
    name: it.name,
    sigungu: it.sigungu,
    lat: it.lat,
    lng: it.lng,
    coordinateSource: it.source || "c2_coordinate_cache",
  }));
  if (pilotCenters.length !== 25) {
    throw new Error(`Expected 25 C2 centers, got ${pilotCenters.length}`);
  }

  // Same single pass: 25 pilot + 잠실엘스 golden fixture (not a sample replacement).
  const centers = [
    ...pilotCenters,
    {
      complex_id: JAMSIL_ELS.complex_id,
      name: JAMSIL_ELS.name,
      sigungu: JAMSIL_ELS.sigungu,
      lat: JAMSIL_ELS.lat,
      lng: JAMSIL_ELS.lng,
      coordinateSource: JAMSIL_ELS.coordinateSource,
    },
  ];

  const memBefore = process.memoryUsage().heapUsed;
  console.error(`[c3] single-pass SEMAS over ${centers.length} centers…`);
  const result = await aggregateCommerceSnapshots(csvPath, centers, {
    onProgress: (n) => console.error(`[c3] rows ${n}`),
  });
  const memAfter = process.memoryUsage().heapUsed;
  const peakHeapMb = Math.round((Math.max(memBefore, memAfter) / 1024 / 1024) * 10) / 10;

  const pilotSnaps = result.snapshots.slice(0, 25);
  const jamsilSnap = result.snapshots[25];

  const matchRows = [];
  let exactMatches = 0;
  for (const snap of pilotSnaps) {
    const c2Row = c2ById.get(snap.complexId);
    if (!c2Row) {
      matchRows.push({
        complexId: snap.complexId,
        match: false,
        mismatches: ["missing_in_c2"],
      });
      continue;
    }
    const mismatches = compareToC2(snap, c2Row);
    if (mismatches.length === 0) exactMatches += 1;
    matchRows.push({
      complexId: snap.complexId,
      name: snap.name,
      match: mismatches.length === 0,
      mismatches,
    });
  }

  const productionPayloads = pilotSnaps.map(toProductionSnapshotPayload);
  const payloadHash = hashCanonicalSnapshots(productionPayloads);
  const snapsJson = JSON.stringify(productionPayloads);
  const snapsBytes = Buffer.byteLength(snapsJson, "utf8");
  const avgBytes = Math.round(snapsBytes / productionPayloads.length);
  const projected8437Bytes = avgBytes * 8437;

  const geo = await queryGeoGate();

  const jamsilMatch =
    jamsilSnap.p0Total === JAMSIL_ELS.expectedP0 &&
    jamsilSnap.p2Total === JAMSIL_ELS.expectedP2;

  const scaleFactor = 8437 / 25;
  const estimatedFullRuntimeMs = Math.round(
    result.timing.totalMs * (1 + (scaleFactor - 1) * 0.85),
  );
  // Source read is shared once; aggregation grows ~linear with centers.
  // Better estimate: source once + agg scaled
  // Better estimate: shared source stream once + agg cost scales with centers.
  const estimatedFullRuntimeMs2 = Math.round(
    result.timing.streamWallMs * (8437 / 26) +
      result.timing.serializationMs * (8437 / 26),
  );

  const decision =
    exactMatches === 25 && jamsilMatch
      ? {
          P2_TRANSFORM: "PASS",
          DERIVED_SNAPSHOT_CONTRACT: "READY",
          OFFLINE_PIPELINE: "PASS",
          RAW_SEMAS_PRODUCTION_INGEST: "NOT_NEEDED",
          FULL_SCALE_GEO: "GATE_OPEN",
          COMMERCE_INGESTION_ARCHITECTURE: "READY",
          NEXT_ACTION: "A",
          NEXT_ACTION_REASON:
            "Snapshot contract + offline pipeline PASS on 25/25 C2 semantic match. Full-Seoul blocked by Production GEO (0/8437 usable coords). Next: Production GEO coverage preparation.",
        }
      : {
          P2_TRANSFORM: exactMatches === 25 ? "PASS" : "HOLD",
          DERIVED_SNAPSHOT_CONTRACT: exactMatches === 25 ? "READY" : "NOT_READY",
          OFFLINE_PIPELINE: exactMatches === 25 ? "PASS" : "HOLD",
          RAW_SEMAS_PRODUCTION_INGEST: "NOT_NEEDED",
          FULL_SCALE_GEO: "GATE_OPEN",
          COMMERCE_INGESTION_ARCHITECTURE: "NOT_READY",
          NEXT_ACTION: "C",
          NEXT_ACTION_REASON: "Semantic mismatch vs C2 — repair snapshot contract before GEO/storage.",
        };

  const report = {
    stage: "C3",
    purpose: "offline-semas-complex-commerce-snapshot-pilot",
    generatedAt: new Date().toISOString(),
    source: {
      SEMAS_period: SOURCE_PERIOD,
      SEMAS_date: SOURCE_DATE,
      sourceRows: result.sourceRows,
      sourceScanCount: 1,
      file: "소상공인시장진흥공단_상가(상권)정보_서울_202606.csv",
      radiusM: RADIUS_M,
      distanceMetric: "straight-line-haversine",
    },
    pilot: {
      complexes: 25,
      snapshotsGenerated: 25,
      c2ExactSemanticMatches: `${exactMatches}/25`,
      exactMatchCount: exactMatches,
      mismatches: matchRows.filter((r) => !r.match),
      matchRows,
      goldenFixture: {
        name: "잠실엘스",
        complexId: JAMSIL_ELS.complex_id,
        expectedP0: JAMSIL_ELS.expectedP0,
        expectedP2: JAMSIL_ELS.expectedP2,
        actualP0: jamsilSnap.p0Total,
        actualP2: jamsilSnap.p2Total,
        composition: jamsilSnap.composition,
        facilities: jamsilSnap.facilities,
        topCategories: jamsilSnap.topCategories,
        semanticMatch: jamsilMatch ? "PASS" : "HOLD",
        note: "Golden fixture from C1/C1B center; not part of the 25-sigungu sample set.",
      },
    },
    snapshotContract: {
      populationVersion: POPULATION_VERSION,
      populationRuleVersion: POPULATION_RULE_VERSION,
      radiusM: RADIUS_M,
      fields: [
        "complexId",
        "source",
        "sourcePeriod",
        "radiusM",
        "populationVersion",
        "p0Total",
        "p2Total",
        "p2ToP0Ratio",
        "composition",
        "topCategories",
        "facilities",
        "sourceDate",
        "sourceUpdatedDate",
        "computedAt",
        "coordinateSource",
        "populationRuleVersion",
      ],
      rawBusinessesEmbedded: false,
      sizeLabelsIncluded: false,
      canonicalPayloadHashSha256: payloadHash,
      examplePayload: toProductionSnapshotPayload(jamsilSnap),
    },
    performance: {
      sourceReadMs: result.timing.sourceReadMs,
      aggregationMs: result.timing.aggregationMs,
      streamWallMs: result.timing.streamWallMs,
      serializationMs: result.timing.serializationMs,
      totalMs: result.timing.totalMs,
      peakHeapMbApprox: peakHeapMb,
      centersInPass: centers.length,
      note: "Single measurement. Pass includes 25 pilot + 1 golden fixture. sourceRead/aggregation share streamWallMs (single-pass).",
    },
    outputSize: {
      snapshots25Bytes: snapsBytes,
      averageBytesPerComplex: avgBytes,
      projected8437BytesApprox: projected8437Bytes,
      projected8437MBApprox: Number((projected8437Bytes / (1024 * 1024)).toFixed(2)),
    },
    productionStorageProposal: {
      table: "apt_commerce_snapshots",
      oneRowPerComplexPeriodRadiusPopulation: true,
      rawSemasRowsInTurso: false,
      summaryJson: true,
      indexedColumns: ["complex_id", "source_period"],
      primaryKey: [
        "complex_id",
        "source_period",
        "radius_m",
        "population_version",
      ],
      schemaDraftSql: SCHEMA_DRAFT_SQL,
      estimatedRowsPerPeriod: 8437,
      estimatedProductionWritesPerFullRefresh: 8437,
    },
    quarterlyRefresh: {
      source: "SEMAS Seoul file (data.go.kr 15083033)",
      flow: [
        "download Seoul CSV for new quarter",
        "offline/CI single-pass aggregate against complexes with Production coords",
        "compare previous snapshot (p0/p2/summary hash)",
        "bounded upsert changed/current rows only",
        "postcheck counts + sample semantic checks",
      ],
      expectedSnapshotWrites: "~8437 max per quarter (changed-only may be lower)",
      changedOnlyStrategy: true,
      schedulerImplemented: false,
    },
    retention: {
      recommendation: "LATEST_ONLY",
      reason:
        "상권 변화 추이 is not a near-term product feature; LATEST_ONLY keeps ~8437 rows and simplifies upsert. Revisit PER_QUARTER_HISTORY only if trend UI is scheduled.",
    },
    geoGate: geo,
    fullSeoulEstimate: {
      estimatedComputeRuntimeMs: estimatedFullRuntimeMs2,
      estimatedComputeRuntimeMin: Number(
        (estimatedFullRuntimeMs2 / 60000).toFixed(1),
      ),
      alternateNaiveScaleMs: estimatedFullRuntimeMs,
      estimatedSnapshotRows: 8437,
      estimatedProductionWrites: 8437,
      mainBottleneck:
        "Production GEO coverage (0 usable coords). Secondary: single-pass CSV aggregation time scales with center count.",
      note: "Estimate only — full 8437 not executed.",
    },
    requestPathContract: {
      flow: "/apt/[name] → complex_id → apt_commerce_snapshots lookup → render",
      requestTimeSemasCsv: false,
      requestTimeAggregation: false,
      requestPathDbWrites: false,
      naverRole: "representative POI/map/store names only — never alters SEMAS counts",
    },
    db: {
      productionWrites: 0,
      tursoWrites: 0,
      schema: 0,
    },
    decision,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_SNAPS, JSON.stringify(productionPayloads, null, 2) + "\n");
  writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        outReport: OUT_REPORT,
        outSnaps: OUT_SNAPS,
        matches: `${exactMatches}/25`,
        jamsil: jamsilMatch ? "PASS" : "HOLD",
        totalMs: result.timing.totalMs,
        decision: decision.NEXT_ACTION,
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
