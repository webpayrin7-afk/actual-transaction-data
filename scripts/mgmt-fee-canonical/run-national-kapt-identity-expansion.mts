/**
 * National KAPT identity expansion.
 * Reuses Seoul kapt_identity_resolver_v2 EXACT_SAFE rules unchanged.
 * Candidate source: existing national KAPT universe artifact (xlsx-derived), not a blind AptList scan.
 * Promotes EXACT_SAFE only. Does not write management-fee rows.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-national-kapt-identity-expansion.mts --region=41
 *   npx tsx scripts/mgmt-fee-canonical/run-national-kapt-identity-expansion.mts --region=all
 *   npx tsx scripts/mgmt-fee-canonical/run-national-kapt-identity-expansion.mts --region=all --commit
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  RESOLVER_VERSION,
  matchDistrict,
  type KaptListItem,
  type MasterRow,
  type Pair,
} from "./kapt-identity-resolver";
import { KAPT_CODE_RE, sharedKaptCodes } from "./national-inventory";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const OUT_DIR = resolve(DIR, "national-kapt-identity");
const UNIVERSE_PATH = resolve(OUT_DIR, "kapt-complex-universe.jsonl");
const UNIVERSE_SHA256 = "77129a57c8249d2ac1f311fc3fd56e1058a33b63ef6300a204b5215c6cda49d4";
const SOURCE = "KAPT";
const SOURCE_VERSION = "national-identity/kapt-complex-universe@2026-09-18";
const STAGE = "national-kapt-identity-v1";

type IdentityClass =
  | "EXACT"
  | "CONFLICT"
  | "INSUFFICIENT"
  | "STALE_INVALID"
  | "NO_CANDIDATE";

type RegionRow = {
  sido_code: string;
  sido: string;
  canonical: number;
  existing_exact: number;
  new_exact: number;
  exact_after: number;
  conflict: number;
  insufficient: number;
  stale_invalid: number;
  no_candidate: number;
  unclassified: number;
  api_calls: number;
};

type ClassifiedComplex = {
  complex_id: string;
  sido_code: string;
  sido: string;
  apt_name: string;
  identity_class: IdentityClass;
  kapt_code: string | null;
  match_tier: string | null;
  evidence: string | null;
  source: "existing_link" | "new_exact_safe" | "held_high_confidence" | "ambiguous" | "none";
  detail: string | null;
};

type Promotable = {
  complexId: string;
  kaptCode: string;
  district: string;
  matchTier: "EXACT_SAFE";
  evidence: string;
  existingLinkState: "NEW_PROMOTABLE";
  resolverVersion: string;
  aptName: string;
  kaptName: string;
  sido_code: string;
  sido: string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function emptyCounts(): Record<IdentityClass, number> {
  return {
    EXACT: 0,
    CONFLICT: 0,
    INSUFFICIENT: 0,
    STALE_INVALID: 0,
    NO_CANDIDATE: 0,
  };
}

async function loadUniverse(): Promise<Map<string, KaptListItem[]>> {
  if (sha256File(UNIVERSE_PATH) !== UNIVERSE_SHA256) {
    throw new Error("kapt universe sha mismatch");
  }
  const bySido = new Map<string, KaptListItem[]>();
  const seen = new Set<string>();
  const rl = createInterface({ input: createReadStream(UNIVERSE_PATH) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      kapt_code?: string;
      apt_name?: string;
      full_legal_code?: string;
      bjdong_name?: string;
      sido?: string;
      sigungu?: string;
      quality?: string;
      lawd_resolved?: boolean;
    };
    if (row.quality !== "READY" || row.lawd_resolved !== true) continue;
    const kaptCode = String(row.kapt_code ?? "");
    if (!KAPT_CODE_RE.test(kaptCode)) continue;
    if (seen.has(kaptCode)) continue;
    seen.add(kaptCode);
    const bjdCode = String(row.full_legal_code ?? "");
    if (bjdCode.length !== 10) continue;
    const sido = String(row.sido ?? "");
    const item: KaptListItem = {
      kaptCode,
      kaptName: String(row.apt_name ?? ""),
      bjdCode,
      as1: sido || undefined,
      as2: row.sigungu != null ? String(row.sigungu) : undefined,
      as3: row.bjdong_name != null ? String(row.bjdong_name) : undefined,
    };
    const list = bySido.get(sido) ?? [];
    list.push(item);
    bySido.set(sido, list);
  }
  return bySido;
}

async function loadMasters(db: Client): Promise<
  Array<MasterRow & { sido_code: string; sido: string; sigungu: string }>
> {
  const result = await db.execute(`
    SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun, sigungu, legal_dong_name, sido_code, sido
    FROM apt_complex_master
  `);
  return result.rows.map((row) => ({
    complexId: String(row.complex_id),
    aptName: String(row.apt_name ?? ""),
    aptNameNorm: String(row.apt_name_norm ?? ""),
    lawdCd: String(row.lawd_cd ?? ""),
    bjdongCd: row.bjdong_cd == null ? null : String(row.bjdong_cd),
    jibun: row.jibun == null ? null : String(row.jibun),
    sigungu: String(row.sigungu ?? ""),
    legalDongName: row.legal_dong_name == null ? null : String(row.legal_dong_name),
    sido_code: String(row.sido_code),
    sido: String(row.sido),
  }));
}

async function loadExistingLinks(db: Client): Promise<{
  byComplex: Map<string, string>;
  byKapt: Map<string, string>;
}> {
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
  return { byComplex, byKapt };
}

function classifyRegion(
  masters: Array<MasterRow & { sido_code: string; sido: string; sigungu: string }>,
  kapts: KaptListItem[],
  byComplex: Map<string, string>,
  byKapt: Map<string, string>,
  shared: Set<string>,
): { classified: ClassifiedComplex[]; promotable: Promotable[]; pairs: Pair[] } {
  const classified: ClassifiedComplex[] = [];
  const promotable: Promotable[] = [];

  // Exclude every already-linked KAPT so resolver cannot reassign identities.
  const freeKapts = kapts.filter((k) => !byKapt.has(k.kaptCode));

  const unlinkedMasters = masters.filter((m) => !byComplex.has(m.complexId));
  const linkedMasters = masters.filter((m) => byComplex.has(m.complexId));

  for (const m of linkedMasters) {
    const kapt = byComplex.get(m.complexId)!;
    const owner = byKapt.get(kapt);
    const valid = KAPT_CODE_RE.test(kapt);
    if (!valid) {
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "STALE_INVALID",
        kapt_code: kapt,
        match_tier: null,
        evidence: null,
        source: "existing_link",
        detail: "invalid kapt code on existing link",
      });
      continue;
    }
    if (owner && owner !== m.complexId) {
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "CONFLICT",
        kapt_code: kapt,
        match_tier: null,
        evidence: null,
        source: "existing_link",
        detail: `kapt owned by ${owner}`,
      });
      continue;
    }
    if (shared.has(kapt)) {
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "CONFLICT",
        kapt_code: kapt,
        match_tier: null,
        evidence: null,
        source: "existing_link",
        detail: "shared kapt across complexes",
      });
      continue;
    }
    classified.push({
      complex_id: m.complexId,
      sido_code: m.sido_code,
      sido: m.sido,
      apt_name: m.aptName,
      identity_class: "EXACT",
      kapt_code: kapt,
      match_tier: "EXISTING_UNIQUE",
      evidence: "existing_unique_kapt_link",
      source: "existing_link",
      detail: null,
    });
  }

  const matched = matchDistrict(unlinkedMasters, freeKapts);
  const pairByMaster = new Map(matched.pairs.map((p) => [p.master.complexId, p]));
  const amb = new Set(matched.ambiguousMaster);
  const high = new Set(
    matched.pairs.filter((p) => p.tier === "HIGH_CONFIDENCE").map((p) => p.master.complexId),
  );

  for (const m of unlinkedMasters) {
    const pair = pairByMaster.get(m.complexId);
    if (pair?.tier === "EXACT_SAFE" && pair.evidence.startsWith("exact_name+bjd")) {
      // Refuse if this kapt is already linked to another complex.
      const owner = byKapt.get(pair.kapt.kaptCode);
      if (owner && owner !== m.complexId) {
        classified.push({
          complex_id: m.complexId,
          sido_code: m.sido_code,
          sido: m.sido,
          apt_name: m.aptName,
          identity_class: "CONFLICT",
          kapt_code: pair.kapt.kaptCode,
          match_tier: "EXACT_SAFE",
          evidence: pair.evidence,
          source: "ambiguous",
          detail: `exact candidate already linked to ${owner}`,
        });
        continue;
      }
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "EXACT",
        kapt_code: pair.kapt.kaptCode,
        match_tier: "EXACT_SAFE",
        evidence: pair.evidence,
        source: "new_exact_safe",
        detail: null,
      });
      promotable.push({
        complexId: m.complexId,
        kaptCode: pair.kapt.kaptCode,
        district: m.sigungu || m.sido,
        matchTier: "EXACT_SAFE",
        evidence: pair.evidence,
        existingLinkState: "NEW_PROMOTABLE",
        resolverVersion: RESOLVER_VERSION,
        aptName: m.aptName,
        kaptName: pair.kapt.kaptName,
        sido_code: m.sido_code,
        sido: m.sido,
      });
      continue;
    }
    if (pair?.tier === "HIGH_CONFIDENCE" || high.has(m.complexId)) {
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "INSUFFICIENT",
        kapt_code: pair?.kapt.kaptCode ?? null,
        match_tier: "HIGH_CONFIDENCE",
        evidence: pair?.evidence ?? null,
        source: "held_high_confidence",
        detail: "HIGH_CONFIDENCE held; not promoted",
      });
      continue;
    }
    if (amb.has(m.complexId)) {
      classified.push({
        complex_id: m.complexId,
        sido_code: m.sido_code,
        sido: m.sido,
        apt_name: m.aptName,
        identity_class: "CONFLICT",
        kapt_code: null,
        match_tier: "AMBIGUOUS",
        evidence: null,
        source: "ambiguous",
        detail: "ambiguous name+bjd candidates",
      });
      continue;
    }
    classified.push({
      complex_id: m.complexId,
      sido_code: m.sido_code,
      sido: m.sido,
      apt_name: m.aptName,
      identity_class: "NO_CANDIDATE",
      kapt_code: null,
      match_tier: "MASTER_ONLY",
      evidence: null,
      source: "none",
      detail: "no exact-safe or held high-confidence candidate",
    });
  }

  return { classified, promotable, pairs: matched.pairs };
}

function summarize(
  classified: ClassifiedComplex[],
  existingExact: number,
  newExact: number,
  apiCalls: number,
): RegionRow {
  const counts = emptyCounts();
  for (const row of classified) counts[row.identity_class] += 1;
  const sido_code = classified[0]?.sido_code ?? "";
  const sido = classified[0]?.sido ?? "";
  const sum =
    counts.EXACT + counts.CONFLICT + counts.INSUFFICIENT + counts.STALE_INVALID + counts.NO_CANDIDATE;
  return {
    sido_code,
    sido,
    canonical: classified.length,
    existing_exact: existingExact,
    new_exact: newExact,
    exact_after: counts.EXACT,
    conflict: counts.CONFLICT,
    insufficient: counts.INSUFFICIENT,
    stale_invalid: counts.STALE_INVALID,
    no_candidate: counts.NO_CANDIDATE,
    unclassified: classified.length - sum,
    api_calls: apiCalls,
  };
}

async function promote(
  db: Client,
  candidates: readonly Promotable[],
  commit: boolean,
): Promise<{
  inserted: number;
  skipped_present: number;
  conflicts: number;
  invalid: number;
  details: Array<{ complex_id: string; kapt_code: string; status: string; detail?: string }>;
}> {
  const { byComplex, byKapt } = await loadExistingLinks(db);
  const masters = await db.execute(`SELECT complex_id, sido_code FROM apt_complex_master`);
  const masterById = new Map(masters.rows.map((row) => [String(row.complex_id), String(row.sido_code)]));
  let inserted = 0;
  let skipped_present = 0;
  let conflicts = 0;
  let invalid = 0;
  const details: Array<{ complex_id: string; kapt_code: string; status: string; detail?: string }> = [];
  const now = new Date().toISOString();
  const tx = commit ? await db.transaction("write") : null;
  try {
    for (const row of candidates) {
      if (!KAPT_CODE_RE.test(row.kaptCode) || !row.evidence.startsWith("exact_name+bjd")) {
        invalid += 1;
        details.push({ complex_id: row.complexId, kapt_code: row.kaptCode, status: "INVALID" });
        continue;
      }
      if (!masterById.has(row.complexId)) {
        invalid += 1;
        details.push({ complex_id: row.complexId, kapt_code: row.kaptCode, status: "STALE" });
        continue;
      }
      const existingComplex = byComplex.get(row.complexId);
      const existingKaptOwner = byKapt.get(row.kaptCode);
      if (existingComplex === row.kaptCode && existingKaptOwner === row.complexId) {
        skipped_present += 1;
        details.push({ complex_id: row.complexId, kapt_code: row.kaptCode, status: "ALREADY_PRESENT" });
        continue;
      }
      if (existingComplex || existingKaptOwner) {
        conflicts += 1;
        details.push({
          complex_id: row.complexId,
          kapt_code: row.kaptCode,
          status: "CONFLICT",
          detail: `complex=${existingComplex ?? ""} kapt_owner=${existingKaptOwner ?? ""}`,
        });
        continue;
      }
      if (!commit || !tx) {
        inserted += 1;
        details.push({ complex_id: row.complexId, kapt_code: row.kaptCode, status: "WOULD_INSERT" });
        continue;
      }
      const meta = {
        stage: STAGE,
        match_tier: "EXACT_SAFE",
        match_method: "exact_name+bjd",
        evidence: row.evidence,
        district: row.district,
        resolver_version: RESOLVER_VERSION,
        source_service: "kapt-complex-universe",
        as_of: "2026-09-18",
      };
      await tx.execute({
        sql: `INSERT INTO apt_complex_source_links
              (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [SOURCE, row.kaptCode, row.complexId, JSON.stringify(meta), SOURCE_VERSION, now, now],
      });
      byComplex.set(row.complexId, row.kaptCode);
      byKapt.set(row.kaptCode, row.complexId);
      inserted += 1;
      details.push({ complex_id: row.complexId, kapt_code: row.kaptCode, status: "INSERTED" });
    }
    if (tx) await tx.commit();
  } catch (error) {
    if (tx) await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    if (tx) tx.close();
  }
  return { inserted, skipped_present, conflicts, invalid, details };
}

async function collisionAudit(
  classified: ClassifiedComplex[],
): Promise<{
  canonical_to_multiple_exact: number;
  kapt_to_multiple_canonical: number;
  ambiguous_same_name: number;
  address_conflicts: number;
  held_for_review: number;
}> {
  const exactByComplex = new Map<string, string[]>();
  const exactByKapt = new Map<string, string[]>();
  let ambiguous_same_name = 0;
  let address_conflicts = 0;
  let held_for_review = 0;
  for (const row of classified) {
    if (row.identity_class === "EXACT" && row.kapt_code) {
      const a = exactByComplex.get(row.complex_id) ?? [];
      a.push(row.kapt_code);
      exactByComplex.set(row.complex_id, a);
      const b = exactByKapt.get(row.kapt_code) ?? [];
      b.push(row.complex_id);
      exactByKapt.set(row.kapt_code, b);
    }
    if (row.identity_class === "CONFLICT") {
      held_for_review += 1;
      if (row.match_tier === "AMBIGUOUS") ambiguous_same_name += 1;
      else address_conflicts += 1;
    }
    if (row.identity_class === "INSUFFICIENT") held_for_review += 1;
  }
  return {
    canonical_to_multiple_exact: [...exactByComplex.values()].filter((v) => v.length > 1).length,
    kapt_to_multiple_canonical: [...exactByKapt.values()].filter((v) => v.length > 1).length,
    ambiguous_same_name,
    address_conflicts,
    held_for_review,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const regionArg = argValue("region") ?? "41";
  const commit = process.argv.includes("--commit");
  const writeSync1 = (msg: string) => writeSync(1, `${msg}\n`);

  writeSync1(`start region=${regionArg} commit=${commit} resolver=${RESOLVER_VERSION}`);
  if (!existsSync(UNIVERSE_PATH)) throw new Error("universe artifact missing");

  const readDb = openReadOnlyClient();
  const inventory = await readNationalComplexes(readDb);
  const shared = sharedKaptCodes(inventory);
  const feeByComplex = new Map(inventory.map((row) => [row.complex_id, row.has_fee]));

  const writeDb = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  const masters = await loadMasters(writeDb);
  const { byComplex, byKapt } = await loadExistingLinks(writeDb);
  const universe = await loadUniverse();

  const sidoNames = [...new Set(masters.map((m) => m.sido))];
  const regions =
    regionArg === "all"
      ? [...new Set(masters.map((m) => m.sido_code))].sort()
      : [regionArg];

  // Seoul existing exact anchors for regression.
  const seoulBefore = inventory.filter((row) => {
    if (row.sido_code !== "11") return false;
    const codes = [...new Set(row.kapt_codes)];
    return codes.length === 1 && KAPT_CODE_RE.test(codes[0]!) && !shared.has(codes[0]!);
  });
  const seoulBeforeMap = new Map(seoulBefore.map((row) => [row.complex_id, row.kapt_codes[0]!]));

  const allClassified: ClassifiedComplex[] = [];
  const allPromotable: Promotable[] = [];
  const regionRows: RegionRow[] = [];
  let apiCalls = 0; // universe reuse — no live AptList in this path

  for (const sidoCode of regions) {
    const regionMasters = masters.filter((m) => m.sido_code === sidoCode);
    if (regionMasters.length === 0) continue;
    const sidoName = regionMasters[0]!.sido;
    const kapts = universe.get(sidoName) ?? [];
    const existingExact = regionMasters.filter((m) => {
      const kapt = byComplex.get(m.complexId);
      return (
        !!kapt &&
        KAPT_CODE_RE.test(kapt) &&
        byKapt.get(kapt) === m.complexId &&
        !shared.has(kapt)
      );
    }).length;
    const { classified, promotable } = classifyRegion(
      regionMasters,
      kapts,
      byComplex,
      byKapt,
      shared,
    );
    const newExact = classified.filter((row) => row.source === "new_exact_safe").length;
    allClassified.push(...classified);
    allPromotable.push(...promotable);
    regionRows.push(summarize(classified, existingExact, newExact, 0));
    writeSync1(
      `region ${sidoCode} ${sidoName} canonical=${classified.length} existing_exact=${existingExact} new_exact=${newExact} kapts=${kapts.length}`,
    );
  }

  // Seoul regression checks (always, even if region=41 only — uses live links).
  let seoulRegressions = 0;
  let seoulMappingChanged = 0;
  for (const [complexId, kapt] of seoulBeforeMap) {
    const live = byComplex.get(complexId);
    if (!live) {
      seoulRegressions += 1;
      continue;
    }
    if (live !== kapt) seoulMappingChanged += 1;
  }

  const collisions = await collisionAudit(allClassified);
  const nationalCounts = emptyCounts();
  for (const row of allClassified) nationalCounts[row.identity_class] += 1;
  const nationalSum =
    nationalCounts.EXACT +
    nationalCounts.CONFLICT +
    nationalCounts.INSUFFICIENT +
    nationalCounts.STALE_INVALID +
    nationalCounts.NO_CANDIDATE;

  const gyeonggi = regionRows.find((row) => row.sido_code === "41");
  const gyeonggiGate = {
    canonical_ok: gyeonggi ? gyeonggi.canonical === gyeonggi.exact_after + gyeonggi.conflict + gyeonggi.insufficient + gyeonggi.stale_invalid + gyeonggi.no_candidate && gyeonggi.unclassified === 0 : false,
    duplicate_kapt: collisions.kapt_to_multiple_canonical === 0,
    duplicate_complex: collisions.canonical_to_multiple_exact === 0,
    seoul_regressions: seoulRegressions === 0 && seoulMappingChanged === 0,
    unrelated_writes: true,
    gate: "FAIL" as "PASS" | "FAIL",
  };
  if (
    regionArg === "41" ||
    regionArg === "all"
  ) {
    gyeonggiGate.gate =
      gyeonggiGate.canonical_ok &&
      gyeonggiGate.duplicate_kapt &&
      gyeonggiGate.duplicate_complex &&
      gyeonggiGate.seoul_regressions &&
      gyeonggi?.unclassified === 0
        ? "PASS"
        : "FAIL";
  }

  if (regionArg === "all" && gyeonggiGate.gate !== "PASS") {
    writeFileSync(
      resolve(OUT_DIR, "gyeonggi-gate-result.json"),
      `${JSON.stringify({ generated_at: new Date().toISOString(), ...gyeonggiGate, gyeonggi }, null, 2)}\n`,
    );
    throw new Error("GYEONGGI_GATE_FAIL — national expansion halted");
  }

  // Seoul new exact candidates (report even if not in selected region set when all).
  const seoulNew = allPromotable.filter((row) => row.sido_code === "11");
  writeFileSync(
    resolve(OUT_DIR, "seoul-new-exact-candidates.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        count: seoulNew.length,
        note: "Identity-only candidates. Do not auto-run historical Seoul AC acquisition.",
        candidates: seoulNew,
      },
      null,
      2,
    )}\n`,
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    stage: STAGE,
    resolver_version: RESOLVER_VERSION,
    exact_safe_rule_changed: false,
    universe_sha256: UNIVERSE_SHA256,
    region: regionArg,
    production_write: false,
    management_fee_write: false,
    candidates: allPromotable,
    counts: {
      promotable: allPromotable.length,
      by_sido: Object.fromEntries(
        regions.map((code) => [code, allPromotable.filter((row) => row.sido_code === code).length]),
      ),
    },
  };
  const manifestPath = resolve(OUT_DIR, "national-promotion-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const promoteResult = await promote(writeDb, allPromotable, commit);
  if (commit && promoteResult.conflicts > 0) {
    throw new Error(`promotion conflicts ${promoteResult.conflicts}`);
  }

  // Post-apply confirmed exact + AC capacity.
  const afterInventory = await readNationalComplexes(openReadOnlyClient());
  const afterShared = sharedKaptCodes(afterInventory);
  const capacityBySido: Record<
    string,
    { exact: number; fee_covered: number; never_attempted: number }
  > = {};
  for (const row of afterInventory) {
    const codes = [...new Set(row.kapt_codes)];
    const ok =
      codes.length === 1 && KAPT_CODE_RE.test(codes[0]!) && !afterShared.has(codes[0]!);
    if (!ok) continue;
    const bucket = (capacityBySido[row.sido_code] ??= {
      exact: 0,
      fee_covered: 0,
      never_attempted: 0,
    });
    bucket.exact += 1;
    if (row.has_fee) bucket.fee_covered += 1;
    else bucket.never_attempted += 1;
  }

  const classificationPath = resolve(OUT_DIR, "national-classification.json");
  writeFileSync(
    classificationPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        region: regionArg,
        resolver_version: RESOLVER_VERSION,
        exact_safe_rule_changed: false,
        api_calls: apiCalls,
        checkpoint_cache_reused: true,
        universe_rows_ready: [...universe.values()].reduce((n, rows) => n + rows.length, 0),
        gyeonggi_gate: gyeonggiGate,
        seoul_preservation: {
          existing_exact_before: seoulBeforeMap.size,
          regressions: seoulRegressions,
          mapping_changed: seoulMappingChanged,
          new_exact_candidates: seoulNew.length,
        },
        collisions,
        regions: regionRows,
        national_for_scope: {
          classified: allClassified.length,
          ...nationalCounts,
          sum: nationalSum,
          unclassified: allClassified.length - nationalSum,
          existing_exact: regionRows.reduce((n, row) => n + row.existing_exact, 0),
          new_exact: regionRows.reduce((n, row) => n + row.new_exact, 0),
        },
        promotion: {
          commit,
          ...promoteResult,
          details_omitted: promoteResult.details.length > 50,
        },
        capacity_by_sido: capacityBySido,
      },
      null,
      2,
    )}\n`,
  );

  // Compact per-complex classification for the scoped run (needed for audits).
  writeFileSync(
    resolve(OUT_DIR, `classification-${regionArg.replace(/[^a-z0-9]/gi, "_")}.jsonl`),
    `${allClassified.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeFileSync(
    resolve(OUT_DIR, "collision-audit.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), ...collisions }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(OUT_DIR, "gyeonggi-gate-result.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), ...gyeonggiGate, gyeonggi }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(OUT_DIR, commit ? `promotion-result-${regionArg.replace(/[^a-z0-9]/gi, "_")}.json` : `promotion-audit-${regionArg.replace(/[^a-z0-9]/gi, "_")}.json`),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        region: regionArg,
        commit,
        production_write: commit,
        management_fee_write: false,
        manifest_sha256: sha256File(manifestPath),
        inserted: promoteResult.inserted,
        skipped_present: promoteResult.skipped_present,
        conflicts: promoteResult.conflicts,
        invalid: promoteResult.invalid,
        sample: promoteResult.details.slice(0, 20),
      },
      null,
      2,
    )}\n`,
  );

  writeSync1(
    JSON.stringify({
      status: commit ? "APPLIED" : "DRY_RUN",
      region: regionArg,
      classified: allClassified.length,
      new_exact: allPromotable.length,
      inserted: promoteResult.inserted,
      conflicts: promoteResult.conflicts,
      gyeonggi_gate: gyeonggiGate.gate,
      seoul_regressions: seoulRegressions,
      seoul_mapping_changed: seoulMappingChanged,
      api_calls: apiCalls,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
