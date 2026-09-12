#!/usr/bin/env node
/**
 * Phase 6.3 — enrichment framework + GEO foundation runner.
 *
 *   npx tsx scripts/phase63-enrichment-geo.mts
 *   npx tsx scripts/phase63-enrichment-geo.mts --sample
 *   npx tsx scripts/phase63-enrichment-geo.mts --sample --write
 *
 * Never bulk-geocodes the full master universe. Feature flags unchanged.
 */
import { createClient, type Client } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENRICHMENT_DOMAINS,
  selectEnrichmentCandidates,
} from "../src/lib/unit-type/enrichment";
import {
  GEO_DATA_VERSION,
  buildGeoQuery,
  mapGeoMasterRow,
  resolveGeoProvider,
  runGeoEnrichment,
} from "../src/lib/unit-type/geo";

function getDb(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO env required");
  if (url.startsWith("file:") || url === ":memory:") {
    throw new Error("Refusing local DB for phase63 production audit");
  }
  return createClient({ url, authToken });
}

async function count(
  db: Client,
  sql: string,
  args: Array<string | number> = [],
): Promise<number> {
  const r = await db.execute({ sql, args });
  return Number((r.rows[0] as { c: number }).c ?? 0);
}

async function main() {
  const doSample = process.argv.includes("--sample");
  const doWrite = process.argv.includes("--write");
  const db = getDb();
  const provider = resolveGeoProvider();

  const masterN = await count(db, `SELECT COUNT(*) AS c FROM apt_complex_master`);
  const coverage = {
    master: masterN,
    bjdong_cd: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_master WHERE bjdong_cd IS NOT NULL AND TRIM(bjdong_cd)!=''`,
    ),
    jibun: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_master WHERE jibun IS NOT NULL AND TRIM(jibun)!=''`,
    ),
    road_address: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_master WHERE road_address IS NOT NULL AND TRIM(road_address)!=''`,
    ),
    latitude: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_master WHERE latitude IS NOT NULL`,
    ),
    longitude: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_master WHERE longitude IS NOT NULL`,
    ),
    enrichment_rows: await count(
      db,
      `SELECT COUNT(*) AS c FROM apt_complex_enrichment_state`,
    ),
  };

  const all = await db.execute(`
    SELECT complex_id, apt_name, apt_name_norm, sido, sido_code, sigungu,
           lawd_cd, legal_dong_name, bjdong_cd, jibun, road_address,
           latitude, longitude
    FROM apt_complex_master
  `);
  let ready = 0;
  let ambiguous = 0;
  let unresolved = 0;
  for (const row of all.rows) {
    const g = buildGeoQuery(mapGeoMasterRow(row as Record<string, unknown>));
    if (g.inputClass === "GEO-INPUT-READY") ready += 1;
    else if (g.inputClass === "GEO-INPUT-AMBIGUOUS") ambiguous += 1;
    else unresolved += 1;
  }

  const demo: Record<string, { candidate_count: number; params: unknown }> = {};
  for (const [label, params] of [
    [
      "A_geo_missing_v1",
      {
        domain: "GEO" as const,
        dataVersion: 1,
        mode: "missing-only" as const,
        limit: 5000,
      },
    ],
    [
      "B_geo_version_lt_2",
      {
        domain: "GEO" as const,
        dataVersion: 2,
        mode: "version-refresh" as const,
        limit: 5000,
      },
    ],
    [
      "C_unit_group_v3",
      {
        domain: "UNIT_GROUP" as const,
        dataVersion: 3,
        mode: "version-refresh" as const,
        limit: 5000,
      },
    ],
    [
      "D_geo_full_rescan_v1",
      {
        domain: "GEO" as const,
        dataVersion: 1,
        mode: "full-rescan" as const,
        forceAll: true,
        limit: 5000,
      },
    ],
  ] as const) {
    const ids = await selectEnrichmentCandidates(db, params);
    demo[label] = { candidate_count: ids.length, params };
  }

  let sampleAgg: Record<string, unknown> | null = null;
  if (doSample) {
    const phase5 = (
      await db.execute(`
        SELECT DISTINCT complex_id FROM apt_complex_classifications
        WHERE complex_id IS NOT NULL
        LIMIT 20
      `)
    ).rows.map((r) => String(r.complex_id));

    const seoulBun = (
      await db.execute(`
        SELECT complex_id FROM apt_complex_master
        WHERE sido_code='11' AND jibun NOT LIKE '%-%'
        ORDER BY complex_id LIMIT 10
      `)
    ).rows.map((r) => String(r.complex_id));

    const ggJi = (
      await db.execute(`
        SELECT complex_id FROM apt_complex_master
        WHERE sido_code='41' AND jibun LIKE '%-%'
        ORDER BY complex_id LIMIT 10
      `)
    ).rows.map((r) => String(r.complex_id));

    const sameName = (
      await db.execute(`
        SELECT complex_id FROM apt_complex_master
        WHERE apt_name_norm='우성'
        ORDER BY lawd_cd LIMIT 6
      `)
    ).rows.map((r) => String(r.complex_id));

    const ids = [
      ...new Set([...phase5, ...seoulBun, ...ggJi, ...sameName]),
    ].slice(0, 50);

    const allowWrite = doWrite && provider != null;
    const run = await runGeoEnrichment(db, {
      dataVersion: GEO_DATA_VERSION,
      mode: "missing-only",
      limit: 50,
      complexIds: ids,
      write: allowWrite,
      provider,
    });
    sampleAgg = {
      ...run,
      sample_size: ids.length,
      write_blocked_reason:
        doWrite && !provider
          ? "no configured GEO provider (VWORLD_API_KEY / KAKAO_REST_API_KEY)"
          : null,
    };
  }

  const decision: "PASS" | "HOLD" =
    provider != null &&
    sampleAgg != null &&
    Number(sampleAgg.resolved ?? 0) > 0
      ? "PASS"
      : "HOLD";

  const report = {
    phase: "6.3",
    enrichment_framework: {
      missing_only: "YES",
      version_refresh: "YES",
      full_rescan: "YES",
      batched_resumable: "YES",
      high_frequency_queue_required: "NO",
      domains: ENRICHMENT_DOMAINS,
      lazy_rows: true,
    },
    geo_source: {
      selected_source: provider?.id ?? "NONE",
      existing_configured: provider != null,
      external_requests_required: provider != null,
      cache_store_coordinates_allowed:
        provider != null
          ? "YES (provider key present; write gated)"
          : "NO — no provider configured; do not invent/cache",
      estimated_full_universe_request_count_if_eventually_run: ready,
      local_coords_in_repo: 0,
      road_address_coverage: coverage.road_address,
      existing_lat_lng_in_master: coverage.latitude,
    },
    geo_input: {
      canonical_master: masterN,
      "GEO-INPUT-READY": ready,
      AMBIGUOUS: ambiguous,
      UNRESOLVED: unresolved,
    },
    coverage,
    future_candidates_demo: demo,
    geo_sample: sampleAgg,
    storage: {
      lat_lng_in_apt_complex_master: "YES (columns exist; currently empty)",
      geo_state_rows: coverage.enrichment_rows,
      data_version: GEO_DATA_VERSION,
    },
    production_compatibility: {
      flags_changed: "NO",
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA:
        process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "unset",
      POST_WH_SINGOGA_GAPS_CLEARED:
        process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "unset",
    },
    canonical_exceptions: {
      "mapo-raemian-prugio": "unchanged / legacy fallback (not in master)",
    },
    decision,
    next_recommendation:
      decision === "HOLD"
        ? "B) improve GEO source/input coverage — configure VWORLD_API_KEY or KAKAO_REST_API_KEY, then re-run ≤50 sample with --write"
        : "A) controlled GEO bulk enrichment",
  };

  const outDir = resolve("data/poc/phase63");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "phase63-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
