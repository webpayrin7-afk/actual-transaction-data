/**
 * M4 night KAPT source-link promotion helpers.
 * Missing-only INSERT via bounded db.batch (CHUNK=80).
 * No overwrite, no delete, resume-safe, idempotent verify path.
 */
import { readFileSync } from "node:fs";
import type { createClient, InArgs, InStatement } from "@libsql/client";

export type Db = ReturnType<typeof createClient>;

export const SOURCE_KAPT = "KAPT";
export const SOURCE_LINK_INSERT_CHUNK = 80;
export const SOURCE_LINK_IN_CHUNK = 80;
export const SOURCE_VERSION = "stage-m4/m3-manifest-v2";

export const LOCKED_MANIFEST_PATH =
  "data/poc/management/stage-m3-seoul-kapt-identity-promotion-manifest.json";

export type ManifestCandidate = {
  complexId: string;
  kaptCode: string;
  district?: string;
  matchTier?: string;
  evidence?: string;
  existingLinkState?: string;
  resolverVersion?: string;
  aptName?: string;
  kaptName?: string;
};

export type LockedManifest = {
  generatedAt?: string;
  stage?: string;
  resolverVersion?: string;
  expected?: {
    newSourceLinks?: number;
    inserts?: number;
    updates?: number;
    deletes?: number;
  };
  candidates: ManifestCandidate[];
};

export type PrecheckResult = {
  manifestRows: number;
  alreadyMatchingSameLinks: number;
  missingInserts: number;
  unexpectedConflicts: number;
  unexpectedDifferentKaptSameComplex: number;
  unexpectedSameKaptOtherComplex: number;
  slugTargets: number;
  duplicateComplexId: number;
  duplicateKaptCode: number;
  conflictSamples: Array<{
    complexId: string;
    kaptCode: string;
    otherKaptOnComplex: string[];
    otherComplexOnKapt: string[];
  }>;
  missing: ManifestCandidate[];
  ready: boolean;
};

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function loadLockedManifest(path = LOCKED_MANIFEST_PATH): LockedManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as LockedManifest;
  if (!Array.isArray(raw.candidates)) {
    throw new Error(`Manifest missing candidates array: ${path}`);
  }
  return raw;
}

export function verifyManifestIntegrity(candidates: ManifestCandidate[]): {
  rows: number;
  duplicateComplexId: number;
  duplicateKaptCode: number;
  slugTargets: number;
  ok: boolean;
} {
  const cidCounts = new Map<string, number>();
  const kaptCounts = new Map<string, number>();
  let slugTargets = 0;
  for (const c of candidates) {
    cidCounts.set(c.complexId, (cidCounts.get(c.complexId) ?? 0) + 1);
    kaptCounts.set(c.kaptCode, (kaptCounts.get(c.kaptCode) ?? 0) + 1);
    if (!String(c.complexId ?? "").startsWith("cx_")) slugTargets += 1;
  }
  const duplicateComplexId = [...cidCounts.values()].filter((n) => n > 1).length;
  const duplicateKaptCode = [...kaptCounts.values()].filter((n) => n > 1).length;
  return {
    rows: candidates.length,
    duplicateComplexId,
    duplicateKaptCode,
    slugTargets,
    ok:
      candidates.length === 1655 &&
      duplicateComplexId === 0 &&
      duplicateKaptCode === 0 &&
      slugTargets === 0,
  };
}

/** Bounded fetch of existing KAPT links for manifest complex_ids / kapt codes. */
export async function batchLoadExistingKaptLinks(
  db: Db,
  candidates: ManifestCandidate[],
): Promise<{
  byComplex: Map<string, string[]>;
  byKapt: Map<string, string[]>;
}> {
  const byComplex = new Map<string, string[]>();
  const byKapt = new Map<string, string[]>();
  const complexIds = [...new Set(candidates.map((c) => c.complexId))];
  const kaptCodes = [...new Set(candidates.map((c) => c.kaptCode))];

  for (const chunk of chunkArray(complexIds, SOURCE_LINK_IN_CHUNK)) {
    const ph = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT complex_id, source_key FROM apt_complex_source_links
            WHERE source = ? AND complex_id IN (${ph})`,
      args: [SOURCE_KAPT, ...chunk],
    });
    for (const row of r.rows) {
      const cid = String(row.complex_id);
      const key = String(row.source_key);
      const arr = byComplex.get(cid) ?? [];
      if (!arr.includes(key)) arr.push(key);
      byComplex.set(cid, arr);
    }
  }

  for (const chunk of chunkArray(kaptCodes, SOURCE_LINK_IN_CHUNK)) {
    const ph = chunk.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT complex_id, source_key FROM apt_complex_source_links
            WHERE source = ? AND source_key IN (${ph})`,
      args: [SOURCE_KAPT, ...chunk],
    });
    for (const row of r.rows) {
      const cid = String(row.complex_id);
      const key = String(row.source_key);
      const arr = byKapt.get(key) ?? [];
      if (!arr.includes(cid)) arr.push(cid);
      byKapt.set(key, arr);
    }
  }

  return { byComplex, byKapt };
}

export function precheckManifestAgainstLinks(
  candidates: ManifestCandidate[],
  byComplex: Map<string, string[]>,
  byKapt: Map<string, string[]>,
): PrecheckResult {
  const integrity = verifyManifestIntegrity(candidates);
  let alreadyMatchingSameLinks = 0;
  let unexpectedDifferentKaptSameComplex = 0;
  let unexpectedSameKaptOtherComplex = 0;
  const missing: ManifestCandidate[] = [];
  const conflictSamples: PrecheckResult["conflictSamples"] = [];

  for (const c of candidates) {
    const onComplex = byComplex.get(c.complexId) ?? [];
    const onKapt = byKapt.get(c.kaptCode) ?? [];
    const sameOnComplex = onComplex.includes(c.kaptCode);
    const sameOnKapt = onKapt.includes(c.complexId);
    if (sameOnComplex && sameOnKapt) {
      alreadyMatchingSameLinks += 1;
      continue;
    }
    const otherKaptOnComplex = onComplex.filter((k) => k !== c.kaptCode);
    const otherComplexOnKapt = onKapt.filter((id) => id !== c.complexId);
    if (otherKaptOnComplex.length || otherComplexOnKapt.length) {
      if (otherKaptOnComplex.length) unexpectedDifferentKaptSameComplex += 1;
      if (otherComplexOnKapt.length) unexpectedSameKaptOtherComplex += 1;
      if (conflictSamples.length < 20) {
        conflictSamples.push({
          complexId: c.complexId,
          kaptCode: c.kaptCode,
          otherKaptOnComplex,
          otherComplexOnKapt,
        });
      }
      continue;
    }
    missing.push(c);
  }

  const conflictRows =
    candidates.length - alreadyMatchingSameLinks - missing.length;

  return {
    manifestRows: candidates.length,
    alreadyMatchingSameLinks,
    missingInserts: missing.length,
    unexpectedConflicts: conflictRows,
    unexpectedDifferentKaptSameComplex,
    unexpectedSameKaptOtherComplex,
    slugTargets: integrity.slugTargets,
    duplicateComplexId: integrity.duplicateComplexId,
    duplicateKaptCode: integrity.duplicateKaptCode,
    conflictSamples,
    missing,
    ready:
      integrity.ok &&
      conflictRows === 0 &&
      integrity.slugTargets === 0,
  };
}

function insertStatements(
  rows: ManifestCandidate[],
  nowIso: string,
): InStatement[] {
  return rows.map((c) => {
    const meta = {
      stage: "stage-m4-night",
      fromManifest: "stage-m3-seoul-kapt-identity-promotion-manifest",
      matchTier: c.matchTier ?? null,
      evidence: c.evidence ?? null,
      district: c.district ?? null,
      aptName: c.aptName ?? null,
      kaptName: c.kaptName ?? null,
      resolverVersion: c.resolverVersion ?? null,
    };
    return {
      sql: `INSERT INTO apt_complex_source_links
              (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        SOURCE_KAPT,
        c.kaptCode,
        c.complexId,
        JSON.stringify(meta),
        SOURCE_VERSION,
        nowIso,
        nowIso,
      ] as InArgs,
    };
  });
}

export function expectedBatchCallsForRows(n: number): number {
  if (n <= 0) return 0;
  return Math.ceil(n / SOURCE_LINK_INSERT_CHUNK);
}

/**
 * Missing-only batch insert. Caller must pass precheck.missing only.
 * No overwrite / no delete. Empty input = no-op.
 */
export async function batchInsertMissingSourceLinks(
  db: Db,
  missing: ManifestCandidate[],
  nowIso = new Date().toISOString(),
): Promise<{ inserted: number; batchCalls: number }> {
  const stmts = insertStatements(missing, nowIso);
  let batchCalls = 0;
  for (const chunk of chunkArray(stmts, SOURCE_LINK_INSERT_CHUNK)) {
    if (chunk.length === 0) continue;
    await db.batch(chunk, "write");
    batchCalls += 1;
  }
  return { inserted: missing.length, batchCalls };
}

export async function postcheckManifestLinks(
  db: Db,
  candidates: ManifestCandidate[],
): Promise<{
  expected: number;
  actualMatching: number;
  missing: number;
  complexToMultipleKapt: number;
  kaptToMultipleComplex: number;
  slugWrites: number;
  ok: boolean;
}> {
  const { byComplex, byKapt } = await batchLoadExistingKaptLinks(db, candidates);
  let actualMatching = 0;
  let missing = 0;
  let slugWrites = 0;
  for (const c of candidates) {
    if (!c.complexId.startsWith("cx_")) slugWrites += 1;
    const onComplex = byComplex.get(c.complexId) ?? [];
    if (onComplex.includes(c.kaptCode)) actualMatching += 1;
    else missing += 1;
  }
  let complexToMultipleKapt = 0;
  for (const keys of byComplex.values()) {
    if (new Set(keys).size > 1) complexToMultipleKapt += 1;
  }
  let kaptToMultipleComplex = 0;
  for (const cids of byKapt.values()) {
    if (new Set(cids).size > 1) kaptToMultipleComplex += 1;
  }
  return {
    expected: candidates.length,
    actualMatching,
    missing,
    complexToMultipleKapt,
    kaptToMultipleComplex,
    slugWrites,
    ok:
      missing === 0 &&
      actualMatching === candidates.length &&
      complexToMultipleKapt === 0 &&
      kaptToMultipleComplex === 0 &&
      slugWrites === 0,
  };
}
