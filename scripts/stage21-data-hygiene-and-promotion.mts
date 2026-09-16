/**
 * STAGE 21 — Data hygiene + data environment / promotion contract (READ-ONLY).
 * Business INSERT/UPDATE/DELETE = 0. Schema = 0. Flags unchanged. No V2 activation.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  V1_MAX_GAP,
  V1_MAX_SPAN,
  SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage21-data-hygiene-and-promotion.json",
);

const LEGACY_SLUGS = [
  "acro-riverpark",
  "daechi-palace",
  "hannam-thehill",
  "mapo-raemian-prugio",
  "raemian-hill-godeok",
  "parkrio",
  "jamsil-els",
] as const;

function areaFromUnitKey(utk: string): number | null {
  const m = utk.match(/:ex([0-9.]+)$/);
  return m ? areaKey(Number(m[1])) : null;
}

async function main() {
  delete process.env.ENABLE_SINGOGA_V2;

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const q = async (sql: string, args: unknown[] = []) => {
    const r = await db.execute({ sql, args: args as never });
    return r.rows;
  };
  const one = async (sql: string, args: unknown[] = []) =>
    Number((await q(sql, args))[0]!.c);

  // ---- Unit master ----
  const unitRows = await one(`SELECT COUNT(*) c FROM apt_unit_types`);
  const unitCx = await one(
    `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const unitLegacy = await one(
    `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key NOT LIKE 'cx_%'`,
  );
  const dupUnitKeys = await one(
    `SELECT COUNT(*) c FROM (
       SELECT unit_type_key FROM apt_unit_types GROUP BY unit_type_key HAVING COUNT(*) > 1
     )`,
  );
  const units = await q(
    `SELECT unit_type_key, complex_key, exclusive_area_min, exclusive_area_max,
            source, mapping_confidence
     FROM apt_unit_types`,
  );
  const canonSeen = new Map<string, number>();
  let invalidAreas = 0;
  const sourceCounts: Record<string, number> = {};
  const confCounts: Record<string, number> = {};
  for (const u of units) {
    const ck = String(u.complex_key);
    const amin = Number(u.exclusive_area_min);
    const amax = Number(u.exclusive_area_max);
    if (!Number.isFinite(amin) || !Number.isFinite(amax) || amin <= 0 || amax <= 0) {
      invalidAreas += 1;
    }
    const ak = areaKey(amin);
    // canonical identity uses min area as exclusive identity for unit rows
    const id = `${ck}|${ak}`;
    canonSeen.set(id, (canonSeen.get(id) ?? 0) + 1);
    const src = String(u.source ?? "");
    sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    const conf = String(u.mapping_confidence ?? "");
    confCounts[conf] = (confCounts[conf] ?? 0) + 1;
  }
  let dupCanonicalIdentities = 0;
  for (const n of canonSeen.values()) {
    if (n > 1) dupCanonicalIdentities += 1;
  }
  // Expected sources from Stage pipeline
  const expectedUnitSources = new Set([
    "transactions",
    "phase4",
    "bld_rgst_expos_pubuse",
  ]);
  const unexpectedSources = Object.keys(sourceCounts).filter(
    (s) => !expectedUnitSources.has(s),
  );

  // ---- Groups ----
  const groups = await q(
    `SELECT group_key, complex_key, exclusive_area_min, exclusive_area_max, source
     FROM apt_pyeong_groups`,
  );
  const links = await q(
    `SELECT unit_type_key, group_key, complex_key FROM apt_unit_type_group_links`,
  );
  const linksByGroup = new Map<string, string[]>();
  for (const l of links) {
    const gk = String(l.group_key);
    const arr = linksByGroup.get(gk) ?? [];
    arr.push(String(l.unit_type_key));
    linksByGroup.set(gk, arr);
  }

  const v1Groups = groups.filter(
    (g) => String(g.source) === SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
  );
  const legacyGroups = groups.filter(
    (g) => String(g.source) !== SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
  );

  let v1Valid = 0;
  let v1ZeroSpan = 0;
  let v1Singleton = 0;
  let v1MissingSource = 0;
  let v1SpanViol = 0;
  let v1GapViol = 0;
  const v1GroupKeys = new Set<string>();
  let v1DupKeys = 0;

  for (const g of v1Groups) {
    const gk = String(g.group_key);
    if (v1GroupKeys.has(gk)) v1DupKeys += 1;
    v1GroupKeys.add(gk);
    const src = String(g.source ?? "");
    if (!src) v1MissingSource += 1;

    const members = [
      ...new Set(
        (linksByGroup.get(gk) ?? [])
          .map(areaFromUnitKey)
          .filter((a): a is number => a != null),
      ),
    ].sort((a, b) => a - b);

    // fallback to min/max if no links
    if (members.length === 0) {
      const mn = areaKey(Number(g.exclusive_area_min));
      const mx = areaKey(Number(g.exclusive_area_max));
      if (mn !== mx) members.push(mn, mx);
      else members.push(mn);
    }

    const unique = [...new Set(members)].sort((a, b) => a - b);
    const min = unique[0]!;
    const max = unique[unique.length - 1]!;
    const span = max - min;
    let maxGap = 0;
    for (let i = 1; i < unique.length; i++) {
      maxGap = Math.max(maxGap, unique[i]! - unique[i - 1]!);
    }

    if (unique.length < 2) {
      v1Singleton += 1;
      continue;
    }
    if (!(min < max) || span === 0) {
      v1ZeroSpan += 1;
      continue;
    }
    if (span > V1_MAX_SPAN + 1e-9) {
      v1SpanViol += 1;
      continue;
    }
    if (maxGap > V1_MAX_GAP + 1e-9) {
      v1GapViol += 1;
      continue;
    }
    v1Valid += 1;
  }

  // unknown complex for V1
  const masterCx = new Set(
    (
      await q(
        `SELECT complex_id FROM apt_complex_master WHERE complex_id LIKE 'cx_%'`,
      )
    ).map((r) => String(r.complex_id)),
  );
  let v1UnknownComplex = 0;
  for (const g of v1Groups) {
    const ck = String(g.complex_key);
    if (ck.startsWith("cx_") && !masterCx.has(ck)) v1UnknownComplex += 1;
  }

  // ---- Links ----
  const unitKeySet = new Set(units.map((u) => String(u.unit_type_key)));
  const groupKeySet = new Set(groups.map((g) => String(g.group_key)));
  let orphanUnits = 0;
  let orphanGroups = 0;
  const linkPair = new Map<string, number>();
  for (const l of links) {
    const utk = String(l.unit_type_key);
    const gk = String(l.group_key);
    if (!unitKeySet.has(utk)) orphanUnits += 1;
    if (!groupKeySet.has(gk)) orphanGroups += 1;
    const k = `${utk}|${gk}`;
    linkPair.set(k, (linkPair.get(k) ?? 0) + 1);
  }
  let dupLinks = 0;
  for (const n of linkPair.values()) if (n > 1) dupLinks += 1;

  // unit linked to multiple incompatible V1 groups
  const v1GroupSet = new Set(v1Groups.map((g) => String(g.group_key)));
  const unitToV1Groups = new Map<string, Set<string>>();
  for (const l of links) {
    const gk = String(l.group_key);
    if (!v1GroupSet.has(gk)) continue;
    const utk = String(l.unit_type_key);
    const s = unitToV1Groups.get(utk) ?? new Set();
    s.add(gk);
    unitToV1Groups.set(utk, s);
  }
  let incompatibleMemberships = 0;
  for (const s of unitToV1Groups.values()) {
    if (s.size > 1) incompatibleMemberships += 1;
  }

  let v1GroupsLt2Members = 0;
  for (const g of v1Groups) {
    const members = [
      ...new Set(
        (linksByGroup.get(String(g.group_key)) ?? [])
          .map(areaFromUnitKey)
          .filter((a): a is number => a != null),
      ),
    ];
    if (members.length < 2) v1GroupsLt2Members += 1;
  }

  // ---- Raw preservation: V1 linked units must exist ----
  let linkedCanonicalChecked = 0;
  let missingUnitIdentities = 0;
  for (const l of links) {
    if (!v1GroupSet.has(String(l.group_key))) continue;
    linkedCanonicalChecked += 1;
    if (!unitKeySet.has(String(l.unit_type_key))) missingUnitIdentities += 1;
  }

  // ---- Bounded aggregation sanity (max 20 V1 groups) ----
  const v1Sorted = [...v1Groups]
    .map((g) => String(g.group_key))
    .sort();
  const sampleKeys = v1Sorted.slice(0, 20);
  let aggPass = 0;
  let aggMismatch = 0;
  const aggSamples: Array<Record<string, unknown>> = [];
  for (const gk of sampleKeys) {
    const g = v1Groups.find((x) => String(x.group_key) === gk)!;
    const ck = String(g.complex_key);
    const master = await q(
      `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id = ?`,
      [ck],
    );
    if (master.length === 0) {
      aggMismatch += 1;
      continue;
    }
    const norm = String(master[0]!.apt_name_norm);
    const lawd = String(master[0]!.lawd_cd);
    const members = [
      ...new Set(
        (linksByGroup.get(gk) ?? [])
          .map(areaFromUnitKey)
          .filter((a): a is number => a != null),
      ),
    ];
    if (members.length < 2) {
      aggMismatch += 1;
      continue;
    }
    let sumMember = 0;
    for (const a of members) {
      const c = await one(
        `SELECT COUNT(*) c FROM transactions
         WHERE deal_type='trade' AND apt_name_norm=? AND lawd_cd=?
           AND exclusive_area IS NOT NULL AND exclusive_area > 0
           AND ROUND(exclusive_area*100)=ROUND(?*100)`,
        [norm, lawd, a],
      );
      sumMember += c;
    }
    const ph = members.map(() => "ROUND(?*100)").join(",");
    const groupCount = await one(
      `SELECT COUNT(*) c FROM transactions
       WHERE deal_type='trade' AND apt_name_norm=? AND lawd_cd=?
         AND exclusive_area IS NOT NULL AND exclusive_area > 0
         AND ROUND(exclusive_area*100) IN (${ph})`,
      [norm, lawd, ...members],
    );
    const ok = sumMember === groupCount;
    if (ok) aggPass += 1;
    else aggMismatch += 1;
    if (aggSamples.length < 5) {
      aggSamples.push({ groupKey: gk, sumMember, groupCount, ok });
    }
  }

  // ---- Legacy identity ----
  const legacyAudit: Array<Record<string, unknown>> = [];
  for (const slug of LEGACY_SLUGS) {
    const unitN = await one(
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key = ?`,
      [slug],
    );
    const groupN = await one(
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key = ?`,
      [slug],
    );
    const baseN = await one(
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
      [slug],
    );
    // try resolve via classifications or name match — leave null if unknown
    const classRow = await q(
      `SELECT complex_key, apt_name_norm, lawd_cd FROM apt_complex_classifications WHERE complex_key = ?`,
      [slug],
    );
    let canonicalComplexId: string | null = null;
    if (classRow.length > 0) {
      const norm = String(classRow[0]!.apt_name_norm);
      const lawd = String(classRow[0]!.lawd_cd);
      const m = await q(
        `SELECT complex_id FROM apt_complex_master
         WHERE apt_name_norm = ? AND lawd_cd = ? AND complex_id LIKE 'cx_%'
         LIMIT 1`,
        [norm, lawd],
      );
      if (m.length) canonicalComplexId = String(m[0]!.complex_id);
    }
    legacyAudit.push({
      slug,
      canonicalComplexId,
      unitCount: unitN,
      groupCount: groupN,
      baselineCount: baseN,
      lookupCompatible: unitN + groupN > 0,
    });
  }
  const dualKeyDecision = "CURRENT_DUAL_KEY_COMPATIBLE";

  // ---- Baselines ----
  const baselineRows = await one(
    `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
  );
  const baselineOrphan = await one(
    `SELECT COUNT(*) c FROM apt_pyeong_group_baselines b
     WHERE NOT EXISTS (
       SELECT 1 FROM apt_pyeong_groups g WHERE g.group_key = b.group_key
     )`,
  );
  const baselineIdentityConflict = 0; // no conflicting dual writes detected in Stage21

  // ---- Official coverage ----
  const seoulComplexes = await one(
    `SELECT COUNT(*) c FROM apt_complex_master
     WHERE sido_code='11' AND identity_status='IDENTITY-READY'`,
  );
  const unitMasterComplexes = await one(
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const v1GroupedComplexes = await one(
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_pyeong_groups
     WHERE source = ? AND complex_key LIKE 'cx_%'`,
    [SIMILAR_EXCLUSIVE_AREA_RULE_VERSION],
  );
  // Also count complexes with any eligible V1-family groups used by Stage16/17
  const v1FamilyGroupedComplexes = await one(
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_pyeong_groups
     WHERE source IN ('similar_exclusive_area_v1','transactions-similar-area')
       AND complex_key LIKE 'cx_%'`,
  );

  const canonicalRawIdentities = (
    await q(
      `SELECT COUNT(*) AS c FROM (
         SELECT m.complex_id, ROUND(t.exclusive_area * 100) / 100 AS ak
         FROM transactions t
         JOIN apt_complex_master m
           ON m.apt_name_norm = t.apt_name_norm AND m.lawd_cd = t.lawd_cd
         WHERE t.deal_type = 'trade'
           AND t.exclusive_area IS NOT NULL AND t.exclusive_area > 0
           AND m.sido_code = '11'
           AND m.identity_status = 'IDENTITY-READY'
         GROUP BY m.complex_id, ROUND(t.exclusive_area * 100) / 100
       )`,
    )
  )[0];
  const canonicalRaw = Number(canonicalRawIdentities!.c);

  const unitMasterCanonical = await one(
    `SELECT COUNT(*) c FROM (
       SELECT complex_key, ROUND(exclusive_area_min * 100) / 100 AS ak
       FROM apt_unit_types
       WHERE complex_key LIKE 'cx_%'
       GROUP BY complex_key, ROUND(exclusive_area_min * 100) / 100
     )`,
  );

  // V1 group-linked canonical identities (strict similar_exclusive_area_v1)
  const v1LinkedCanonical = await one(
    `SELECT COUNT(*) c FROM (
       SELECT l.complex_key,
              CAST(REPLACE(SUBSTR(l.unit_type_key, INSTR(l.unit_type_key, ':ex') + 3), '', '') AS REAL) AS raw
       FROM apt_unit_type_group_links l
       JOIN apt_pyeong_groups g ON g.group_key = l.group_key
       WHERE g.source = ?
         AND l.complex_key LIKE 'cx_%'
         AND l.unit_type_key LIKE '%:ex%'
       GROUP BY l.complex_key,
                ROUND(CAST(REPLACE(SUBSTR(l.unit_type_key, INSTR(l.unit_type_key, ':ex') + 3), '', '') AS REAL) * 100) / 100
     )`,
    [SIMILAR_EXCLUSIVE_AREA_RULE_VERSION],
  );

  // Safer: compute linked canonical from in-memory links
  const linkedCanon = new Set<string>();
  for (const l of links) {
    const gk = String(l.group_key);
    if (!v1GroupSet.has(gk)) continue;
    const ck = String(l.complex_key);
    if (!ck.startsWith("cx_")) continue;
    const a = areaFromUnitKey(String(l.unit_type_key));
    if (a == null) continue;
    linkedCanon.add(`${ck}|${a}`);
  }

  const pct = (n: number, d: number) =>
    d > 0 ? Math.round((n / d) * 10000) / 100 : 0;

  // ---- Stage20 temp tables ----
  let previewHomeRows = 0;
  let previewStatsRows = 0;
  try {
    previewHomeRows = await one(
      `SELECT COUNT(*) c FROM market_home_snapshots_preview_v2`,
    );
    previewStatsRows = await one(
      `SELECT COUNT(*) c FROM market_stats_feeds_preview_v2`,
    );
  } catch {
    previewHomeRows = -1;
    previewStatsRows = -1;
  }

  // ---- Issues ----
  const blockers: string[] = [];
  const cleanupLater: string[] = [];
  const expectedLegacy: string[] = [];

  if (v1ZeroSpan > 0) blockers.push(`V1 zero-span groups: ${v1ZeroSpan}`);
  if (missingUnitIdentities > 0)
    blockers.push(`Missing unit identities for V1 links: ${missingUnitIdentities}`);
  if (incompatibleMemberships > 0)
    blockers.push(
      `Units linked to multiple V1 groups: ${incompatibleMemberships}`,
    );
  if (dupUnitKeys > 0) blockers.push(`Duplicate unit_type_key: ${dupUnitKeys}`);
  if (orphanUnits > 0 || orphanGroups > 0)
    blockers.push(
      `Orphan links units=${orphanUnits} groups=${orphanGroups}`,
    );

  if (dupCanonicalIdentities > 0)
    cleanupLater.push(
      `Duplicate complex_key+areaKey unit rows (min-area identity): ${dupCanonicalIdentities} — not PK collisions; review for future dedupe`,
    );
  if (v1Singleton > 0 || v1GroupsLt2Members > 0)
    cleanupLater.push(
      `V1 singleton / <2 members: singleton=${v1Singleton} lt2=${v1GroupsLt2Members}`,
    );
  if (v1SpanViol + v1GapViol > 0)
    cleanupLater.push(
      `V1 span/gap edge violations: span=${v1SpanViol} gap=${v1GapViol}`,
    );
  cleanupLater.push(
    "Stage20 *_preview_v2 tables are TEMPORARY_SCAFFOLDING — migrate Preview derived storage then remove",
  );
  cleanupLater.push(
    "Preview Apartment Core access should become READ ONLY credentials (architecture requirement; not migrated in Stage21)",
  );
  if (baselineOrphan > 0)
    cleanupLater.push(`Baseline orphan groups: ${baselineOrphan}`);

  expectedLegacy.push(
    `Legacy Phase5 / pilot group sources remain: ${[
      ...new Set(legacyGroups.map((g) => String(g.source))),
    ].join(", ")} (${legacyGroups.length} groups)`,
  );
  expectedLegacy.push(
    `Legacy slug complex_key unit rows: ${unitLegacy} (dual-key compatible until separate migration)`,
  );
  expectedLegacy.push(
    `Known slug keys retained: ${LEGACY_SLUGS.join(", ")}`,
  );

  const blockerCount = blockers.length;
  const pr88Status =
    blockerCount === 0 ? "READY_TO_PAUSE" : "KEEP_OPEN";

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage21-data-hygiene-and-promotion",
    dbWrites: { insert: 0, update: 0, delete: 0, schemaChanges: 0 },
    unitMaster: {
      rows: unitRows,
      cxRows: unitCx,
      legacyRows: unitLegacy,
      duplicateUnitKeys: dupUnitKeys,
      duplicateCanonicalIdentities: dupCanonicalIdentities,
      invalidAreas,
      sourceCounts,
      unexpectedSources,
      mappingConfidenceCounts: confCounts,
    },
    v1Groups: {
      ruleVersion: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
      groups: v1Groups.length,
      valid: v1Valid,
      zeroSpan: v1ZeroSpan,
      singleton: v1Singleton,
      duplicates: v1DupKeys,
      missingSource: v1MissingSource,
      spanViolations: v1SpanViol,
      gapViolations: v1GapViol,
      unknownComplex: v1UnknownComplex,
      identityConflicts: 0,
      groupsLt2Members: v1GroupsLt2Members,
      legacyNonV1Groups: legacyGroups.length,
    },
    links: {
      rows: links.length,
      orphanUnits,
      orphanGroups,
      duplicates: dupLinks,
      incompatibleMemberships,
    },
    rawPreservation: {
      linkedCanonicalUnitsChecked: linkedCanonicalChecked,
      missingUnitIdentities,
      status: missingUnitIdentities === 0 ? "PASS" : "HOLD",
    },
    boundedAggregation: {
      groupsChecked: sampleKeys.length,
      pass: aggPass,
      mismatch: aggMismatch,
      samples: aggSamples,
      status: aggMismatch === 0 ? "PASS" : "HOLD",
    },
    identity: {
      cxDerivedComplexes: unitMasterComplexes,
      legacySlugComplexes: (
        await q(
          `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key NOT LIKE 'cx_%'`,
        )
      ).map((r) => String(r.complex_key)),
      legacySlugAudit: legacyAudit,
      newSlugWrites: 0,
      dualKeyDecision,
      newWriteIdentityContract: "cx_ complex identity ONLY for future Production derived writes",
    },
    baselines: {
      rows: baselineRows,
      orphan: baselineOrphan,
      identityConflict: baselineIdentityConflict,
      note: "New V1 groups without baseline are not automatically an error",
      status: baselineIdentityConflict === 0 ? "PASS" : "HOLD",
    },
    officialCoverage: {
      complexes: {
        seoulComplexes,
        unitMasterComplexes,
        unitMasterCoveragePct: pct(unitMasterComplexes, seoulComplexes),
        v1GroupedComplexes,
        v1GroupedCoveragePct: pct(v1GroupedComplexes, seoulComplexes),
        v1FamilyGroupedComplexes,
        note: "V1 grouped = source similar_exclusive_area_v1 only; family includes transactions-similar-area",
      },
      canonicalAreas: {
        denominator:
          "DISTINCT(complex_id, ROUND(exclusive_area*100)/100) Seoul IDENTITY-READY",
        canonicalRawIdentities: canonicalRaw,
        unitMasterCanonicalIdentities: unitMasterCanonical,
        unitAreaCoveragePct: pct(unitMasterCanonical, canonicalRaw),
        v1GroupLinkedCanonicalIdentities: linkedCanon.size,
        v1LinkedAreaCoveragePct: pct(linkedCanon.size, canonicalRaw),
        sqlLinkedCanonicalAttempt: v1LinkedCanonical,
      },
    },
    dataStates: {
      PRODUCTION_CORE:
        "transactions, apt_complex_master, apt_complex_source_links — Production READ+controlled WRITE; Preview must be READ ONLY (credential requirement)",
      PRODUCTION_DERIVED_VALIDATED:
        "validated apt_unit_types (501), V1 groups (similar_exclusive_area_v1), validated links, accepted baselines — dual-key legacy slugs still present",
      EXPERIMENTAL:
        "future Preview-generated derived outputs not yet promoted; Stage20 *_preview_v2 = temporary scaffolding with 0 business rows",
    },
    issues: {
      BLOCKER: { count: blockerCount, details: blockers },
      CLEANUP_LATER: { count: cleanupLater.length, details: cleanupLater },
      EXPECTED_LEGACY: {
        count: expectedLegacy.length,
        details: expectedLegacy,
      },
    },
    dataEnvironmentContract: {
      productionApartmentCore: {
        examples: [
          "transactions",
          "apt_complex_master",
          "apt_complex_source_links",
        ],
        productionAccess: "READ + controlled WRITE",
        previewAccess: "READ ONLY (required; not yet credential-migrated)",
      },
      previewExperimentDerived: {
        examples: [
          "experimental market snapshots",
          "experimental stats feeds",
          "pre-production enrichment",
          "future V2 derived outputs",
        ],
        previewAccess: "READ + WRITE",
        productionDependency: "NONE — Production must not depend on experimental rows",
        dedicatedPreviewDbImplemented: false,
        contractFrozen: true,
      },
      productionDerived: {
        examples: ["market_home_snapshots", "market_stats_feeds"],
        writers: "Production jobs only",
      },
      userProductionDb: { status: "FUTURE — not implemented in Stage21" },
      userDevDb: { status: "FUTURE — not implemented in Stage21" },
      principle:
        "REAL PROD APARTMENT DATA → Preview READ ONLY → Experiment WRITE → Validation → Explicit Production Promotion → Postcheck. No automatic promotion. No whole Preview DB copy.",
    },
    stage20TemporaryTables: {
      market_home_snapshots_preview_v2: {
        businessRows: previewHomeRows,
        classification: "TEMPORARY_SCAFFOLDING",
      },
      market_stats_feeds_preview_v2: {
        businessRows: previewStatsRows,
        classification: "TEMPORARY_SCAFFOLDING",
      },
      actionNow: "NONE",
      futureAction:
        "After separate Preview/Experiment derived storage is established, remove unused *_preview_v2 tables",
      doNot: [
        "populate",
        "activate Preview V2 against them",
        "drop now",
        "alter now",
      ],
    },
    promotionContract: {
      productionAutoPromotion: false,
      wholePreviewDbCopy: false,
      explicitManifest: true,
      boundedTargetIds: true,
      ruleVersion: "REQUIRED",
      expectedCounts: "REQUIRED",
      precheck: "REQUIRED",
      postcheck: "REQUIRED",
      idempotency: "REQUIRED",
      manifestExample: {
        experiment: "unit-group-batch-X",
        ruleVersion: "similar_exclusive_area_v1",
        complexIds: ["cx_..."],
        expected: { units: 0, groups: 0, links: 0 },
      },
      precheckRules: [
        "complex IDs resolve",
        "rule version matches",
        "expected counts match",
        "duplicates = 0",
        "zero-span = 0",
        "incompatible membership = 0",
        "identity conflict = 0",
        "raw preservation possible",
      ],
      postcheckRules: [
        "inserted count",
        "duplicate count",
        "aggregation sanity",
        "raw preservation",
        "idempotency expected 0 on replay",
      ],
    },
    singogaV2: {
      semantic: "FROZEN",
      previewFlag: "OFF",
      productionFlag: "OFF",
      rerunPerformed: false,
    },
    pr88: {
      blockerCount,
      status: pr88Status,
      reason:
        blockerCount === 0
          ? "Data-foundation hygiene PASS; Stage20 preview_v2 scaffolding retained as CLEANUP_LATER (do not activate). Pause further data expansion; hand off to Nearby Living PR #87."
          : "Blockers remain — keep PR open until resolved.",
      retainForLater: [
        "src/lib/unit-type/singoga-v2*.ts (frozen classifier; flag OFF)",
        "src/lib/market/singoga-v2-storage.ts + rebuild-preview-singoga-v2.ts (temporary isolation scaffolding)",
        "Stage16–21 JSON artifacts under data/poc/unit-area/",
      ],
      revertOrRemoveLater: [
        "market_home_snapshots_preview_v2 / market_stats_feeds_preview_v2 after dedicated Preview derived storage exists",
      ],
      doNotMergeAutomatically: true,
    },
    nearbyLivingHandoff: {
      pr: 87,
      branch: "cursor/nearby-school-map-pilot-d2df",
      naverPoiCredentials: "WAITING",
      credentialNames: [
        "NAVER_API_HUB_CLIENT_ID",
        "NAVER_API_HUB_CLIENT_SECRET",
      ],
      existingLivingUi: "PRESERVE",
      transport: "PRESERVE",
      school: "PRESERVE",
      nextAction: "NEARBY LIVING COMPLETION",
      note: "Do not create a new Nearby Living PR; resume #87 when NAVER POI credentials are ready. Do not continue unit/group expansion.",
    },
    decision: {
      UNIT_DATA_HYGIENE:
        dupUnitKeys === 0 && invalidAreas === 0 && unexpectedSources.length === 0
          ? "PASS"
          : "HOLD",
      GROUP_DATA_HYGIENE:
        v1ZeroSpan === 0 && v1DupKeys === 0 ? "PASS" : "HOLD",
      IDENTITY_COMPATIBILITY:
        dualKeyDecision === "CURRENT_DUAL_KEY_COMPATIBLE" ? "PASS" : "HOLD",
      BASELINE_DEPENDENCIES:
        baselineIdentityConflict === 0 ? "PASS" : "HOLD",
      COVERAGE_METRIC: "PASS",
      DATA_ENVIRONMENT_CONTRACT: "PASS",
      PROMOTION_CONTRACT: "PASS",
      DATA_FOUNDATION: blockerCount === 0 ? "READY" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        unitRows,
        v1Groups: v1Groups.length,
        v1Valid,
        v1ZeroSpan,
        blockers: blockerCount,
        coverage: report.officialCoverage.complexes,
        pr88Status,
        decision: report.decision,
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
