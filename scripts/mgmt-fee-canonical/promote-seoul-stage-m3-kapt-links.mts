/**
 * Promote stage-m3 Seoul EXACT_SAFE KAPT identities into apt_complex_source_links.
 * HIGH_CONFIDENCE is audited but not written. No ON CONFLICT overwrite.
 *
 *   npx tsx scripts/mgmt-fee-canonical/promote-seoul-stage-m3-kapt-links.mts
 *   npx tsx scripts/mgmt-fee-canonical/promote-seoul-stage-m3-kapt-links.mts --commit
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { classifyComplex, sharedKaptCodes } from "./national-inventory";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";

const MANIFEST_SHA256 = "75954b99f42aed19cf27e5f701a076ca1a2b7cb03c17cd5389f9e03973e599c7";
const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const MANIFEST_PATH = resolve(DIR, "stage-m3-seoul-kapt-identity-promotion-manifest.json");
const AUDIT_PATH = resolve(DIR, "seoul-stage-m3-kapt-promotion-audit.json");
const RESULT_PATH = resolve(DIR, "seoul-stage-m3-kapt-promotion-result.json");
const SOURCE = "KAPT";
const SOURCE_VERSION = "stage-m3/AptListService4/getSigunguAptList4@2026-09-16";
const KAPT_RE = /^A\d{8}$/;

type Candidate = {
  complexId: string;
  kaptCode: string;
  district: string;
  matchTier: string;
  evidence: string;
  existingLinkState: string;
  resolverVersion: string;
  aptName: string;
  kaptName: string;
};

type Class =
  | "PROMOTABLE"
  | "ALREADY_PRESENT"
  | "CONFLICT"
  | "STALE"
  | "INVALID"
  | "SKIPPED_NON_EXACT";

type Classified = {
  complex_id: string;
  kapt_code: string;
  match_tier: string;
  evidence: string;
  district: string;
  classification: Class;
  detail: string | null;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadExactCandidates(): { all: Candidate[]; exact: Candidate[]; nonExact: Candidate[]; manifestHash: string } {
  const bytes = readFileSync(MANIFEST_PATH);
  const manifest = JSON.parse(bytes.toString("utf8")) as {
    stage: string;
    candidates: Candidate[];
    matchTiersIncluded: string[];
  };
  if (manifest.stage !== "stage-m3") throw new Error("unexpected stage");
  if (manifest.candidates.length !== 1655) throw new Error(`candidate count ${manifest.candidates.length}`);
  const exact = manifest.candidates.filter((row) => row.matchTier === "EXACT_SAFE");
  const nonExact = manifest.candidates.filter((row) => row.matchTier !== "EXACT_SAFE");
  if (exact.length !== 801) throw new Error(`EXACT_SAFE count ${exact.length}`);
  return { all: manifest.candidates, exact, nonExact, manifestHash: createHash("sha256").update(bytes).digest("hex") };
}

async function classifyAgainstLive(
  db: Client,
  exact: readonly Candidate[],
  nonExact: readonly Candidate[],
): Promise<Classified[]> {
  const masters = await db.execute(`SELECT complex_id, sido_code FROM apt_complex_master`);
  const masterById = new Map(masters.rows.map((row) => [String(row.complex_id), String(row.sido_code)]));
  const links = await db.execute({
    sql: `SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = ?`,
    args: [SOURCE],
  });
  const byComplex = new Map<string, string>();
  const byKapt = new Map<string, string>();
  for (const row of links.rows) {
    const complexId = String(row.complex_id);
    const kapt = String(row.source_key);
    byComplex.set(complexId, kapt);
    byKapt.set(kapt, complexId);
  }

  const out: Classified[] = [];
  for (const row of nonExact) {
    out.push({
      complex_id: row.complexId,
      kapt_code: row.kaptCode,
      match_tier: row.matchTier,
      evidence: row.evidence,
      district: row.district,
      classification: "SKIPPED_NON_EXACT",
      detail: "HIGH_CONFIDENCE/name_compatible not promoted",
    });
  }
  for (const row of exact) {
    const base = {
      complex_id: row.complexId,
      kapt_code: row.kaptCode,
      match_tier: row.matchTier,
      evidence: row.evidence,
      district: row.district,
    };
    if (!KAPT_RE.test(row.kaptCode) || !row.evidence.startsWith("exact_name+bjd")) {
      out.push({ ...base, classification: "INVALID", detail: "kapt or evidence gate" });
      continue;
    }
    const sido = masterById.get(row.complexId);
    if (!sido) {
      out.push({ ...base, classification: "STALE", detail: "complex missing from master" });
      continue;
    }
    if (sido !== "11") {
      out.push({ ...base, classification: "INVALID", detail: `sido ${sido}` });
      continue;
    }
    const existing = byComplex.get(row.complexId);
    const owner = byKapt.get(row.kaptCode);
    if (existing === row.kaptCode) {
      out.push({ ...base, classification: "ALREADY_PRESENT", detail: null });
      continue;
    }
    if (existing && existing !== row.kaptCode) {
      out.push({ ...base, classification: "CONFLICT", detail: `complex has ${existing}` });
      continue;
    }
    if (owner && owner !== row.complexId) {
      out.push({ ...base, classification: "CONFLICT", detail: `kapt owned by ${owner}` });
      continue;
    }
    out.push({ ...base, classification: "PROMOTABLE", detail: null });
  }
  return out;
}

async function insertLinks(db: Client, rows: readonly Classified[], now: string): Promise<number> {
  let inserted = 0;
  const tx = await db.transaction("write");
  try {
    for (const row of rows) {
      const existingComplex = await tx.execute({
        sql: `SELECT source_key FROM apt_complex_source_links WHERE source = ? AND complex_id = ? LIMIT 1`,
        args: [SOURCE, row.complex_id],
      });
      if (existingComplex.rows.length > 0) {
        const key = String(existingComplex.rows[0]!.source_key);
        if (key !== row.kapt_code) throw new Error(`HOLD_CONFLICT complex ${row.complex_id} has ${key}`);
        continue;
      }
      const existingKapt = await tx.execute({
        sql: `SELECT complex_id FROM apt_complex_source_links WHERE source = ? AND source_key = ? LIMIT 1`,
        args: [SOURCE, row.kapt_code],
      });
      if (existingKapt.rows.length > 0) {
        const owner = String(existingKapt.rows[0]!.complex_id);
        if (owner !== row.complex_id) throw new Error(`HOLD_CONFLICT kapt ${row.kapt_code} owned by ${owner}`);
        continue;
      }
      const meta = {
        stage: "stage-m3",
        match_tier: row.match_tier,
        match_method: "exact_name+bjd",
        evidence: row.evidence,
        district: row.district,
        resolver_version: "kapt_identity_resolver_v2",
        source_service: "AptListService4/getSigunguAptList4",
        as_of: "2026-09-16T03:29:56.945Z",
      };
      const result = await tx.execute({
        sql: `INSERT INTO apt_complex_source_links
                (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [SOURCE, row.kapt_code, row.complex_id, JSON.stringify(meta), SOURCE_VERSION, now, now],
      });
      if (Number(result.rowsAffected) !== 1) throw new Error(`insert affected ${row.complex_id}`);
      inserted += 1;
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
  return inserted;
}

async function recount(): Promise<Record<string, unknown>> {
  const db = openReadOnlyClient();
  const rows = await readNationalComplexes(db);
  const shared = sharedKaptCodes(rows);
  const focus = ["11", "41", "26", "48"];
  const by: Record<string, { master: number; confirmed_kapt: number; fee: number; ready_unloaded: number }> = {};
  for (const code of focus) {
    by[code] = { master: 0, confirmed_kapt: 0, fee: 0, ready_unloaded: 0 };
  }
  let nationalKapt = 0;
  let nationalFee = 0;
  let nationalReady = 0;
  for (const row of rows) {
    const state = classifyComplex(row, shared);
    const codes = [...new Set(row.kapt_codes)];
    const confirmed = codes.length === 1 && KAPT_RE.test(codes[0]!) && !shared.has(codes[0]!);
    if (confirmed) nationalKapt += 1;
    if (row.has_fee) nationalFee += 1;
    if (state === "READY") nationalReady += 1;
    const bucket = by[row.sido_code];
    if (!bucket) continue;
    bucket.master += 1;
    if (confirmed) bucket.confirmed_kapt += 1;
    if (row.has_fee) bucket.fee += 1;
    if (state === "READY") bucket.ready_unloaded += 1;
  }
  const linkCount = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = ?`,
    args: [SOURCE],
  });
  const dupComplex = await db.execute({
    sql: `SELECT complex_id, COUNT(*) AS n FROM apt_complex_source_links
          WHERE source = ? GROUP BY complex_id HAVING n > 1`,
    args: [SOURCE],
  });
  const dupKapt = await db.execute({
    sql: `SELECT source_key, COUNT(*) AS n FROM apt_complex_source_links
          WHERE source = ? GROUP BY source_key HAVING n > 1`,
    args: [SOURCE],
  });
  return {
    kapt_source_links: Number(linkCount.rows[0]?.n ?? 0),
    duplicate_complex_to_kapt: dupComplex.rows.length,
    duplicate_kapt_to_complex: dupKapt.rows.length,
    by_sido: by,
    national: {
      master: rows.length,
      confirmed_kapt: nationalKapt,
      fee_complexes: nationalFee,
      ready_unloaded: nationalReady,
    },
  };
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  mkdirSync(DIR, { recursive: true });
  if (sha256File(MANIFEST_PATH) !== MANIFEST_SHA256) {
    throw new Error("stage-m3 manifest hash mismatch");
  }
  const { exact, nonExact, manifestHash } = loadExactCandidates();
  if (manifestHash !== MANIFEST_SHA256) throw new Error("manifest hash internal mismatch");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });

  const beforeLinks = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = ?`,
    args: [SOURCE],
  });
  const beforeCount = Number(beforeLinks.rows[0]?.n ?? 0);

  const classified = await classifyAgainstLive(db, exact, nonExact);
  const counts = {
    PROMOTABLE: classified.filter((row) => row.classification === "PROMOTABLE").length,
    ALREADY_PRESENT: classified.filter((row) => row.classification === "ALREADY_PRESENT").length,
    CONFLICT: classified.filter((row) => row.classification === "CONFLICT").length,
    STALE: classified.filter((row) => row.classification === "STALE").length,
    INVALID: classified.filter((row) => row.classification === "INVALID").length,
    SKIPPED_NON_EXACT: classified.filter((row) => row.classification === "SKIPPED_NON_EXACT").length,
  };
  const promotable = classified.filter((row) => row.classification === "PROMOTABLE");
  writeFileSync(
    AUDIT_PATH,
    `${JSON.stringify({
      generated_at: new Date().toISOString(),
      manifest_sha256: manifestHash,
      stage_m3_candidates: 1655,
      exact_safe: exact.length,
      high_confidence_skipped: nonExact.length,
      counts,
      production_write: false,
    }, null, 2)}\n`,
  );

  if (counts.CONFLICT > 0) {
    console.log(JSON.stringify({ status: "HOLD_CONFLICT", counts, api_calls: 0 }));
    process.exit(2);
  }
  if (!commit) {
    console.log(JSON.stringify({ status: "PRECHECK_OK", counts, promotable: promotable.length, before_kapt_links: beforeCount, api_calls: 0 }));
    return;
  }

  const now = new Date().toISOString();
  const inserted = await insertLinks(db, promotable, now);
  const afterLinks = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM apt_complex_source_links WHERE source = ?`,
    args: [SOURCE],
  });
  const afterCount = Number(afterLinks.rows[0]?.n ?? 0);
  if (afterCount !== beforeCount + inserted) {
    throw new Error(`link count ${afterCount} expected ${beforeCount + inserted}`);
  }
  const coverage = await recount();
  const body = {
    status: "PASS",
    production_write: true,
    inserted_source_links: inserted,
    positive_overwrites: 0,
    before_kapt_links: beforeCount,
    after_kapt_links: afterCount,
    counts,
    gyeonggi_identity_artifact: "GYEONGGI_IDENTITY_ARTIFACT_MISSING",
    coverage,
    updated_at: now,
    source: SOURCE,
    source_version: SOURCE_VERSION,
    manifest_sha256: manifestHash,
    api_calls: 0,
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(JSON.stringify({
    status: "PASS",
    inserted,
    after_kapt_links: afterCount,
    seoul_ready: (coverage.by_sido as Record<string, { ready_unloaded: number }>)["11"]?.ready_unloaded,
    gyeonggi_ready: (coverage.by_sido as Record<string, { ready_unloaded: number }>)["41"]?.ready_unloaded,
    duplicate_complex_to_kapt: coverage.duplicate_complex_to_kapt,
    duplicate_kapt_to_complex: coverage.duplicate_kapt_to_complex,
    api_calls: 0,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "promote failed");
  process.exit(1);
});
