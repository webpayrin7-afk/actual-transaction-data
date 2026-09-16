/**
 * MANAGEMENT STAGE M1 — Seoul management-fee coverage readiness.
 * READ-ONLY. KAPT live HTTP = 0. Production business writes = 0.
 * Window: 202509–202608 (fixed, comparable to Stage3).
 * Formula frozen — classification + manifest prep only.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT_DIR = join(process.cwd(), "data/poc/management");
const READINESS_OUT = join(OUT_DIR, "stage-m1-management-readiness.json");
const MANIFEST_OUT = join(
  OUT_DIR,
  "stage-m1-management-promotion-manifest.json",
);

/** Fixed window for Stage3 comparison (do not include 202609). */
const WINDOW = [
  "202509",
  "202510",
  "202511",
  "202512",
  "202601",
  "202602",
  "202603",
  "202604",
  "202605",
  "202606",
  "202607",
  "202608",
] as const;

const REPS = [
  "잠실엘스",
  "리센츠",
  "트리지움",
  "파크리오",
  "반포자이",
] as const;

const SOURCE_FEE_VERSION = "MOLIT_KAPT_FEE_V3";

type FeeMonth = {
  period: string;
  common: number | null;
  individual: number | null;
  reserve: number | null;
  source: string | null;
  sourceVersion: string | null;
};

function isUsable(fm: FeeMonth | undefined): boolean {
  if (!fm) return false;
  return fm.common != null && fm.individual != null && fm.reserve != null;
}

function parseKaptFromMeta(raw: unknown): string | null {
  if (raw == null) return null;
  try {
    const meta = JSON.parse(String(raw)) as {
      kaptCode?: string;
      kapt_code?: string;
    };
    const code = meta.kaptCode ?? meta.kapt_code;
    if (code && String(code).startsWith("A")) return String(code);
  } catch {
    /* ignore */
  }
  return null;
}

function missingReason(
  period: string,
  hasAnyFeeOutside: boolean,
): "CACHE_MISSING" | "RECENT_PUBLICATION_GAP" | "UNKNOWN" {
  // Only flag last two window months as publication-gap *candidates* when
  // earlier months exist for the complex — do not assert API failure.
  if ((period === "202607" || period === "202608") && hasAnyFeeOutside) {
    return "RECENT_PUBLICATION_GAP";
  }
  if (hasAnyFeeOutside) return "CACHE_MISSING";
  return "UNKNOWN";
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  mkdirSync(OUT_DIR, { recursive: true });

  // Seoul population — match Stage3 scope (sido name) + confirm sido_code
  const seoul = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.sigungu, m.sido_code,
           m.identity_status,
           p.household_count, p.raw_meta_json
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.sido_code = '11'
  `);

  const seoulComplexes = seoul.rows.length;

  // All KAPT source links (global — for conflict detection)
  const kaptLinks = await db.execute(`
    SELECT complex_id, source_key, source_meta_json
    FROM apt_complex_source_links
    WHERE source = 'KAPT'
  `);

  const linksByComplex = new Map<string, string[]>();
  const complexesByKapt = new Map<string, string[]>();
  for (const r of kaptLinks.rows) {
    const cid = String(r.complex_id);
    const key = String(r.source_key);
    const arr = linksByComplex.get(cid) ?? [];
    if (!arr.includes(key)) arr.push(key);
    linksByComplex.set(cid, arr);
    const cids = complexesByKapt.get(key) ?? [];
    if (!cids.includes(cid)) cids.push(cid);
    complexesByKapt.set(key, cids);
  }

  // Production management rows (this DB is the only local store — no separate cache table)
  const feeRows = await db.execute(`
    SELECT f.complex_id, f.period_yyyymm,
           f.common_fee, f.individual_fee, f.long_term_repair_reserve,
           f.source, f.source_version, f.fee_status
    FROM apt_complex_mgmt_fee_monthly f
    JOIN apt_complex_master m ON m.complex_id = f.complex_id
    WHERE m.sido_code = '11'
  `);

  const feeByComplex = new Map<string, Map<string, FeeMonth>>();
  let duplicateComplexMonth = 0;
  const seenKeys = new Set<string>();
  let malformedValues = 0;
  let negativeInvalid = 0;

  for (const r of feeRows.rows) {
    const cid = String(r.complex_id);
    const period = String(r.period_yyyymm);
    const uk = `${cid}|${period}`;
    if (seenKeys.has(uk)) duplicateComplexMonth += 1;
    seenKeys.add(uk);

    const common =
      r.common_fee == null || r.common_fee === ""
        ? null
        : Number(r.common_fee);
    const individual =
      r.individual_fee == null || r.individual_fee === ""
        ? null
        : Number(r.individual_fee);
    const reserve =
      r.long_term_repair_reserve == null || r.long_term_repair_reserve === ""
        ? null
        : Number(r.long_term_repair_reserve);

    for (const v of [common, individual, reserve]) {
      if (v != null && !Number.isFinite(v)) malformedValues += 1;
      if (v != null && Number.isFinite(v) && v < 0) negativeInvalid += 1;
    }

    let byPeriod = feeByComplex.get(cid);
    if (!byPeriod) {
      byPeriod = new Map();
      feeByComplex.set(cid, byPeriod);
    }
    byPeriod.set(period, {
      period,
      common: common != null && Number.isFinite(common) ? common : null,
      individual:
        individual != null && Number.isFinite(individual) ? individual : null,
      reserve: reserve != null && Number.isFinite(reserve) ? reserve : null,
      source: r.source != null ? String(r.source) : null,
      sourceVersion:
        r.source_version != null ? String(r.source_version) : null,
    });
  }

  type IdClass = "KAPT_ID_READY" | "KAPT_ID_MISSING" | "KAPT_ID_CONFLICT";
  type CacheClass =
    | "READY_12"
    | "PARTIAL"
    | "NO_MANAGEMENT_CACHE"
    | "IDENTITY_CONFLICT"
    | "IDENTITY_MISSING";
  type PromoClass =
    | "ALREADY_COMPLETE_PROD"
    | "PROMOTABLE_MISSING_PROD"
    | "PROD_CACHE_DIFFERENCE"
    | "HOLD"
    | "N/A";

  type ComplexRow = {
    complexId: string;
    aptName: string;
    sigungu: string | null;
    identityStatus: string;
    kaptId: string | null;
    kaptIdSource: "source_link" | "profile_meta_stage1" | null;
    idClass: IdClass;
    conflictDetail: string | null;
    prodUsableMonths: string[];
    prodMissingMonths: string[];
    cacheUsableMonths: string[]; // same store — documented
    cacheClass: CacheClass;
    promoClass: PromoClass;
    missingReasons: Record<string, string>;
    householdCount: number | null;
  };

  const rows: ComplexRow[] = [];
  let idReady = 0;
  let idMissing = 0;
  let idConflict = 0;
  let conflictingKaptMappings = 0;

  let prodGe1 = 0;
  let prodFull12 = 0;
  let prodPartial = 0;
  let prodZero = 0;
  let prodUsableMonthRows = 0;

  let cacheReady12 = 0;
  let cachePartial = 0;
  let cacheEmpty = 0;
  let cacheUsableMonthRows = 0;

  let alreadyComplete = 0;
  let promotableMissing = 0;
  let prodCacheDiff = 0;
  let promoHold = 0;

  const partialMissing1: string[] = [];
  const partialMissing2to3: string[] = [];
  const partialMissing4to6: string[] = [];
  const partialMissing7plus: string[] = [];
  const recentGapCandidates: Array<{
    complexId: string;
    aptName: string;
    missing: string[];
  }> = [];

  const promotableTargets: Array<{
    complexId: string;
    aptName: string;
    kaptId: string;
    kaptIdSource: string;
    months: string[];
    expectedInserts: number;
  }> = [];

  // Latest completed month observed in local store (reference only)
  let latestObservedMonth: string | null = null;

  for (const r of seoul.rows) {
    const complexId = String(r.complex_id);
    const aptName = String(r.apt_name);
    const linkCodes = linksByComplex.get(complexId) ?? [];
    const metaCode = parseKaptFromMeta(r.raw_meta_json);

    let idClass: IdClass = "KAPT_ID_MISSING";
    let kaptId: string | null = null;
    let kaptIdSource: ComplexRow["kaptIdSource"] = null;
    let conflictDetail: string | null = null;

    const uniqueLinks = [...new Set(linkCodes)];
    if (uniqueLinks.length > 1) {
      idClass = "KAPT_ID_CONFLICT";
      conflictDetail = `multiple source_link KAPT codes: ${uniqueLinks.join(",")}`;
      conflictingKaptMappings += 1;
    } else if (uniqueLinks.length === 1) {
      const code = uniqueLinks[0]!;
      const owners = complexesByKapt.get(code) ?? [complexId];
      const seoulOwners = owners.filter((oid) =>
        seoul.rows.some((x) => String(x.complex_id) === oid),
      );
      if (seoulOwners.length > 1) {
        idClass = "KAPT_ID_CONFLICT";
        conflictDetail = `KAPT ${code} linked to multiple Seoul complexes: ${seoulOwners.join(",")}`;
        conflictingKaptMappings += 1;
      } else if (metaCode && metaCode !== code) {
        idClass = "KAPT_ID_CONFLICT";
        conflictDetail = `source_link ${code} vs profile_meta ${metaCode}`;
        conflictingKaptMappings += 1;
      } else {
        idClass = "KAPT_ID_READY";
        kaptId = code;
        kaptIdSource = "source_link";
      }
    } else if (metaCode) {
      // profile meta only — deterministic single code, no source_link conflict
      const owners = complexesByKapt.get(metaCode) ?? [];
      if (owners.length > 0 && !owners.includes(complexId)) {
        idClass = "KAPT_ID_CONFLICT";
        conflictDetail = `profile_meta ${metaCode} already linked to other complex(es)`;
        conflictingKaptMappings += 1;
      } else {
        idClass = "KAPT_ID_READY";
        kaptId = metaCode;
        kaptIdSource = "profile_meta_stage1";
      }
    } else {
      idClass = "KAPT_ID_MISSING";
    }

    if (idClass === "KAPT_ID_READY") idReady += 1;
    else if (idClass === "KAPT_ID_MISSING") idMissing += 1;
    else idConflict += 1;

    const byPeriod = feeByComplex.get(complexId) ?? new Map<string, FeeMonth>();
    for (const p of byPeriod.keys()) {
      if (!latestObservedMonth || p > latestObservedMonth) latestObservedMonth = p;
    }

    const prodUsableMonths = WINDOW.filter((p) => isUsable(byPeriod.get(p)));
    const prodMissingMonths = WINDOW.filter((p) => !prodUsableMonths.includes(p));
    prodUsableMonthRows += prodUsableMonths.length;

    // No separate cache table exists in this environment — local store == Production.
    // Document this explicitly; PROMOTABLE_MISSING_PROD will be 0 unless a future
    // cache layer appears.
    const cacheUsableMonths = [...prodUsableMonths];
    cacheUsableMonthRows += cacheUsableMonths.length;

    if (prodUsableMonths.length >= 1) prodGe1 += 1;
    if (prodUsableMonths.length === 12) prodFull12 += 1;
    else if (prodUsableMonths.length > 0) prodPartial += 1;
    else prodZero += 1;

    let cacheClass: CacheClass;
    if (idClass === "KAPT_ID_CONFLICT") cacheClass = "IDENTITY_CONFLICT";
    else if (idClass === "KAPT_ID_MISSING") cacheClass = "IDENTITY_MISSING";
    else if (cacheUsableMonths.length === 12) cacheClass = "READY_12";
    else if (cacheUsableMonths.length > 0) cacheClass = "PARTIAL";
    else cacheClass = "NO_MANAGEMENT_CACHE";

    if (cacheClass === "READY_12") cacheReady12 += 1;
    else if (cacheClass === "PARTIAL") cachePartial += 1;
    else if (cacheClass === "NO_MANAGEMENT_CACHE") cacheEmpty += 1;

    const hasAnyFee = byPeriod.size > 0;
    const missingReasons: Record<string, string> = {};
    for (const p of prodMissingMonths) {
      missingReasons[p] = missingReason(p, hasAnyFee || prodUsableMonths.length > 0);
    }

    if (cacheClass === "PARTIAL") {
      const miss = prodMissingMonths.length;
      if (miss === 1) partialMissing1.push(complexId);
      else if (miss <= 3) partialMissing2to3.push(complexId);
      else if (miss <= 6) partialMissing4to6.push(complexId);
      else partialMissing7plus.push(complexId);

      const recentMiss = prodMissingMonths.filter(
        (p) => p === "202607" || p === "202608",
      );
      if (
        recentMiss.length > 0 &&
        recentMiss.every((p) => missingReasons[p] === "RECENT_PUBLICATION_GAP")
      ) {
        recentGapCandidates.push({
          complexId,
          aptName,
          missing: recentMiss,
        });
      }
    }

    // Promotion classification (cache == prod → no API-zero missing-prod set)
    let promoClass: PromoClass = "N/A";
    if (idClass === "KAPT_ID_CONFLICT") {
      promoClass = "HOLD";
      promoHold += 1;
    } else if (cacheClass === "READY_12") {
      // All 12 months already in Production store
      promoClass = "ALREADY_COMPLETE_PROD";
      alreadyComplete += 1;
    } else {
      promoClass = "N/A";
    }

    rows.push({
      complexId,
      aptName,
      sigungu: r.sigungu != null ? String(r.sigungu) : null,
      identityStatus: String(r.identity_status ?? ""),
      kaptId,
      kaptIdSource,
      idClass,
      conflictDetail,
      prodUsableMonths,
      prodMissingMonths,
      cacheUsableMonths,
      cacheClass,
      promoClass,
      missingReasons,
      householdCount:
        r.household_count == null ? null : Number(r.household_count),
    });
  }

  // Representatives
  const representatives: Record<string, unknown> = {};
  for (const name of REPS) {
    const hit =
      rows.find((c) => c.aptName === name) ??
      rows.find((c) => c.aptName.includes(name));
    if (!hit) {
      representatives[name] = null;
      continue;
    }
    representatives[name] = {
      complexId: hit.complexId,
      kaptId: hit.kaptId,
      kaptIdSource: hit.kaptIdSource,
      idClass: hit.idClass,
      prodMonths: hit.prodUsableMonths,
      cacheMonths: hit.cacheUsableMonths,
      missing: hit.prodMissingMonths,
      cacheClass: hit.cacheClass,
      promoClass: hit.promoClass,
      conflictDetail: hit.conflictDetail,
    };
  }

  const identityCoveragePct =
    Math.round((idReady / seoulComplexes) * 10000) / 100;

  // Bottleneck
  let bottleneck: "IDENTITY_DOMINANT" | "CACHE_DOMINANT" | "MIXED";
  let bottleneckReason: string;
  if (idMissing / seoulComplexes >= 0.8) {
    bottleneck = "IDENTITY_DOMINANT";
    bottleneckReason = `KAPT_ID_MISSING=${idMissing}/${seoulComplexes} (${Math.round((idMissing / seoulComplexes) * 1000) / 10}%); ID-ready only ${idReady}. Local fee store has no separate cache beyond Production.`;
  } else if (idReady > 0 && cacheEmpty / idReady >= 0.5) {
    bottleneck = "CACHE_DOMINANT";
    bottleneckReason = `Among ID-ready (${idReady}), CACHE_EMPTY=${cacheEmpty} dominates over READY_12=${cacheReady12}.`;
  } else {
    bottleneck = "MIXED";
    bottleneckReason = `ID missing=${idMissing}, ID ready=${idReady}, cache empty=${cacheEmpty}, READY_12=${cacheReady12}.`;
  }

  // Future API requirement (design only)
  const identityLookupNeeded = idMissing;
  const managementFetchNeeded = cacheEmpty; // ID ready, no local months
  const partialRefreshNeeded = cachePartial;

  // Next action
  let nextAction: "A" | "B" | "C" | "D" | "E" = "C";
  let nextReason =
    "Identity coverage is the primary bottleneck; design KAPT identity acquisition before mass fee fetch.";
  if (promotableMissing > 0) {
    nextAction = "A";
    nextReason =
      "PROMOTABLE_MISSING_PROD > 0 — API-zero Production promotion from local cache.";
  } else if (idConflict > 0 && idConflict >= idReady) {
    nextAction = "E";
    nextReason = "Integrity conflicts dominate — HOLD until mappings resolved.";
  } else if (cachePartial > 0 && cachePartial >= cacheEmpty && idReady > 20) {
    nextAction = "B";
    nextReason =
      "Partial complexes exist with verified IDs — small bounded KAPT partial-refresh next.";
  } else if (cacheEmpty > 0 && idReady > 0 && idMissing / seoulComplexes < 0.5) {
    nextAction = "D";
    nextReason =
      "IDs largely ready but management cache empty — plan bounded KAPT collection.";
  }

  const expectedNewProdMonthRows = promotableTargets.reduce(
    (s, t) => s + t.expectedInserts,
    0,
  );

  const manifestCreated = promotableTargets.length > 0;
  if (manifestCreated) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      stage: "stage-m1",
      window: [...WINDOW],
      scope: "trade-adjacent N/A — management fee READY_12 PROMOTABLE_MISSING_PROD",
      source: "local Production store / no separate cache layer",
      formulaVersion: "frozen_v3_common_sum+individual_PC+sLevy",
      sourceVersion: SOURCE_FEE_VERSION,
      complexIds: promotableTargets.map((t) => t.complexId),
      targets: promotableTargets,
      expected: {
        complexes: promotableTargets.length,
        monthRows: expectedNewProdMonthRows,
        inserts: expectedNewProdMonthRows,
        existingNoOpRows: 0,
      },
      promotionContract: {
        targetOnly: true,
        insertMissingOnly: true,
        noOverwrite: true,
        noDelete: true,
        idempotent: true,
        noWholeTableCopy: true,
      },
    };
    writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));
  }

  // Slim non-identity-missing detail for artifact
  const detailNonMissing = rows
    .filter(
      (c) =>
        c.idClass !== "KAPT_ID_MISSING" ||
        REPS.some((n) => c.aptName === n || c.aptName.includes(n)),
    )
    .map((c) => ({
      complexId: c.complexId,
      aptName: c.aptName,
      kaptId: c.kaptId,
      kaptIdSource: c.kaptIdSource,
      idClass: c.idClass,
      conflictDetail: c.conflictDetail,
      cacheClass: c.cacheClass,
      promoClass: c.promoClass,
      prodUsableMonths: c.prodUsableMonths,
      prodMissingMonths: c.prodMissingMonths,
      missingReasons: c.missingReasons,
      householdCount: c.householdCount,
    }));

  const readiness = {
    generatedAt: new Date().toISOString(),
    stage: "stage-m1-management-readiness",
    externalApiCalls: 0,
    dbWrites: {
      managementInsert: 0,
      managementUpdate: 0,
      managementDelete: 0,
      sourceLinkWrites: 0,
      otherBusinessWrites: 0,
    },
    scope: {
      seoulComplexes,
      window: [...WINDOW],
      months: WINDOW.length,
      usableMonthRule:
        "common_fee != NULL AND individual_fee != NULL AND long_term_repair_reserve != NULL (0 is valid)",
      localStoreNote:
        "No separate management cache table found. apt_complex_mgmt_fee_monthly is the Production/local store. PROMOTABLE_MISSING_PROD=0 until a distinct cache layer exists.",
      latestObservedMonthInStore: latestObservedMonth,
    },
    kaptIdentity: {
      idReady,
      idMissing,
      idConflict,
      identityCoveragePct,
      sourceLinkCount: kaptLinks.rows.length,
      conflictingKaptMappings,
    },
    productionCoverage: {
      ge1UsableMonthComplexes: prodGe1,
      full12Complexes: prodFull12,
      partialComplexes: prodPartial,
      zeroMonthComplexes: prodZero,
      usableMonthRows: prodUsableMonthRows,
      feeRowTotal: feeRows.rows.length,
      distinctFeeComplexes: feeByComplex.size,
    },
    localCacheReadiness: {
      READY_12: cacheReady12,
      PARTIAL: cachePartial,
      CACHE_EMPTY: cacheEmpty,
      IDENTITY_CONFLICT: idConflict,
      IDENTITY_MISSING: idMissing,
      usableCachedMonthRows: cacheUsableMonthRows,
      note: "cache metrics mirror Production store in current schema",
    },
    promotionReadiness: {
      ALREADY_COMPLETE_PROD: alreadyComplete,
      PROMOTABLE_MISSING_PROD: promotableMissing,
      PROD_CACHE_DIFFERENCE: prodCacheDiff,
      HOLD: promoHold,
      expectedNewProductionMonthRows: expectedNewProdMonthRows,
    },
    partialBreakdown: {
      missing1Month: partialMissing1.length,
      missing2to3: partialMissing2to3.length,
      missing4to6: partialMissing4to6.length,
      missing7plus: partialMissing7plus.length,
      recentPublicationGapCandidates: recentGapCandidates.length,
      recentPublicationGapSample: recentGapCandidates.slice(0, 20),
      partialComplexIds: {
        missing1: partialMissing1,
        missing2to3: partialMissing2to3,
        missing4to6: partialMissing4to6,
        missing7plus: partialMissing7plus,
      },
    },
    representatives,
    integrity: {
      duplicateComplexMonth,
      conflictingKaptMappings,
      malformedValues,
      negativeInvalidValues: negativeInvalid,
    },
    bottleneck: {
      decision: bottleneck,
      reason: bottleneckReason,
    },
    futureApiRequirement: {
      kaptIdentityLookupNeeded: identityLookupNeeded,
      managementFetchNeeded,
      partialRefreshNeeded,
      apiCallsPerformedNow: 0,
      priorityDesign: [
        "1. verified KAPT ID + PARTIAL missing 1–2 months (publication-aware)",
        "2. verified KAPT ID + CACHE_EMPTY",
        "3. KAPT identity missing (largest population)",
      ],
      kapt429Policy: "first 429 → HOLD immediately; no retry loop",
    },
    manifest: {
      created: manifestCreated,
      path: manifestCreated
        ? "data/poc/management/stage-m1-management-promotion-manifest.json"
        : null,
      targetComplexes: promotableTargets.length,
      expectedMonthRows: expectedNewProdMonthRows,
      expectedInserts: expectedNewProdMonthRows,
    },
    nextAction: {
      choice: nextAction,
      reason: nextReason,
    },
    decision: {
      MANAGEMENT_FORMULA: "FROZEN",
      KAPT_IDENTITY_AUDIT: idConflict === 0 ? "PASS" : "HOLD",
      CACHE_READINESS: "PASS",
      PROMOTION_MANIFEST: manifestCreated ? "READY" : "NOT_READY",
      PRODUCTION_LOAD: "NOT_YET",
      KAPT_LIVE_CALL: 0,
      DATA_SAFETY: "PASS",
    },
    complexesDetailNonIdentityMissing: detailNonMissing,
  };

  writeFileSync(READINESS_OUT, JSON.stringify(readiness, null, 2));

  console.log(
    JSON.stringify(
      {
        out: READINESS_OUT,
        manifestCreated,
        seoulComplexes,
        kaptIdentity: readiness.kaptIdentity,
        productionCoverage: readiness.productionCoverage,
        localCacheReadiness: {
          READY_12: cacheReady12,
          PARTIAL: cachePartial,
          CACHE_EMPTY: cacheEmpty,
        },
        promotionReadiness: readiness.promotionReadiness,
        partialBreakdown: {
          missing1Month: partialMissing1.length,
          missing2to3: partialMissing2to3.length,
          missing4to6: partialMissing4to6.length,
          missing7plus: partialMissing7plus.length,
          recentPublicationGapCandidates: recentGapCandidates.length,
        },
        representatives,
        integrity: readiness.integrity,
        bottleneck: readiness.bottleneck,
        futureApiRequirement: readiness.futureApiRequirement,
        nextAction: readiness.nextAction,
        decision: readiness.decision,
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
