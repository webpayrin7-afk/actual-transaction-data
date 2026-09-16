/**
 * STAGE M4 — Night KAPT source-link promotion (LOCKED M3 manifest).
 *
 * Default: DRY precheck only (Production writes = 0).
 * Apply:   npx tsx scripts/stage-m4-kapt-source-link-night-promote.mts --apply
 *
 * Rules:
 * - Same locked manifest only (no resolver / KAPT rediscovery)
 * - Missing-only INSERT via db.batch chunks of 80
 * - No overwrite / no delete
 * - On conflict > 0: abort (NIGHT_PROMOTION_NOT_READY)
 * - After apply: postcheck + verify-only idempotency replay (no second write)
 */
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import {
  LOCKED_MANIFEST_PATH,
  SOURCE_LINK_INSERT_CHUNK,
  batchInsertMissingSourceLinks,
  batchLoadExistingKaptLinks,
  expectedBatchCallsForRows,
  loadLockedManifest,
  postcheckManifestLinks,
  precheckManifestAgainstLinks,
  verifyManifestIntegrity,
} from "./lib/kapt-source-link-night-promotion";

config({ path: ".env.local" });
config();

const APPLY = process.argv.includes("--apply");
const ROOT = resolve(import.meta.dirname, "..");
const OUT =
  resolve(ROOT, "data/poc/management/stage-m4-kapt-source-link-night-run.json");

async function main() {
  const manifest = loadLockedManifest(
    resolve(ROOT, LOCKED_MANIFEST_PATH),
  );
  const integrity = verifyManifestIntegrity(manifest.candidates);
  if (!integrity.ok) {
    throw new Error(
      `Manifest integrity HOLD: rows=${integrity.rows} dupC=${integrity.duplicateComplexId} dupK=${integrity.duplicateKaptCode} slug=${integrity.slugTargets}`,
    );
  }

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const { byComplex, byKapt } = await batchLoadExistingKaptLinks(
    db,
    manifest.candidates,
  );
  const precheck = precheckManifestAgainstLinks(
    manifest.candidates,
    byComplex,
    byKapt,
  );

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    stage: "stage-m4-kapt-source-link-night",
    mode: APPLY ? "APPLY" : "DRY",
    manifestPath: LOCKED_MANIFEST_PATH,
    integrity,
    precheck: {
      manifestRows: precheck.manifestRows,
      alreadyMatchingSameLinks: precheck.alreadyMatchingSameLinks,
      missingInserts: precheck.missingInserts,
      unexpectedConflicts: precheck.unexpectedConflicts,
      unexpectedDifferentKaptSameComplex:
        precheck.unexpectedDifferentKaptSameComplex,
      unexpectedSameKaptOtherComplex: precheck.unexpectedSameKaptOtherComplex,
      ready: precheck.ready,
      conflictSamples: precheck.conflictSamples,
    },
    batch: {
      chunkSize: SOURCE_LINK_INSERT_CHUNK,
      expectedBatchCalls: expectedBatchCallsForRows(precheck.missingInserts),
    },
    writes: { inserted: 0, updated: 0, deleted: 0, batchCalls: 0 },
    postcheck: null as unknown,
    idempotencyReplay: null as unknown,
    decision: precheck.ready
      ? APPLY
        ? "APPLYING"
        : "NIGHT_SOURCE_LINK_PROMOTION_READY_DRY"
      : "NIGHT_PROMOTION_NOT_READY",
  };

  if (!precheck.ready) {
    mkdirSync(resolve(ROOT, "data/poc/management"), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.error("NIGHT_PROMOTION_NOT_READY", report.precheck);
    process.exitCode = 2;
    return;
  }

  if (!APPLY) {
    mkdirSync(resolve(ROOT, "data/poc/management"), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { inserted, batchCalls } = await batchInsertMissingSourceLinks(
    db,
    precheck.missing,
  );
  (report.writes as { inserted: number; batchCalls: number }).inserted =
    inserted;
  (report.writes as { inserted: number; batchCalls: number }).batchCalls =
    batchCalls;

  const post = await postcheckManifestLinks(db, manifest.candidates);
  report.postcheck = post;

  // Idempotency: verify-only replay (no second write)
  const { byComplex: bc2, byKapt: bk2 } = await batchLoadExistingKaptLinks(
    db,
    manifest.candidates,
  );
  const replay = precheckManifestAgainstLinks(
    manifest.candidates,
    bc2,
    bk2,
  );
  report.idempotencyReplay = {
    wouldInsert: replay.missingInserts,
    wouldUpdate: 0,
    wouldDelete: 0,
    unexpectedConflicts: replay.unexpectedConflicts,
    pass:
      replay.missingInserts === 0 &&
      replay.unexpectedConflicts === 0 &&
      replay.alreadyMatchingSameLinks === manifest.candidates.length,
  };

  report.decision =
    post.ok &&
    (report.idempotencyReplay as { pass: boolean }).pass
      ? "NIGHT_SOURCE_LINK_PROMOTION_PASS"
      : "NIGHT_SOURCE_LINK_PROMOTION_HOLD";

  mkdirSync(resolve(ROOT, "data/poc/management"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
