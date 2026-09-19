/**
 * Sample-run household input only.
 * Does not write apt_complex_profile and does not invent a household.
 */

import type { ProfileInput } from "./features";

export const POC_COHORT_ORIGIN = "ORIGINAL_POC";
export const POC_PROFILE_SOURCE = "CORE_PROFILE_AUDIT_20260919";
export const POC_PROFILE_AS_OF = "2026-09-19";

export type PocConfidence = "HIGH" | "MEDIUM" | "LOW";

export type PocHouseholdInput = {
  complexId: string;
  householdCount: number;
  profileConfidence: PocConfidence;
  profileSource: string;
  profileAsOf: string;
  cohortOrigin: typeof POC_COHORT_ORIGIN;
};

export type WarehouseHousehold = {
  householdCount: number | null;
  source: string | null;
  sourceKey: string | null;
  sourceAsOf: string | null;
};

export type ProfileResolution =
  | {
      status: "PRODUCTION_MATCH" | "POC_OVERLAY";
      profile: ProfileInput;
    }
  | {
      status: "PROFILE_CONFLICT";
      productionHousehold: number;
      pocHousehold: number;
    };

function isConfidence(value: unknown): value is PocConfidence {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

export function parsePocCohort(raw: unknown): PocHouseholdInput[] {
  if (!raw || typeof raw !== "object") throw new Error("cohort must be an object");
  const doc = raw as Record<string, unknown>;
  if (doc.cohort_origin !== POC_COHORT_ORIGIN) {
    throw new Error("cohort_origin must be ORIGINAL_POC");
  }
  if (doc.profile_source !== POC_PROFILE_SOURCE) {
    throw new Error("profile_source must be the audit label");
  }
  if (doc.profile_as_of !== POC_PROFILE_AS_OF) {
    throw new Error("profile_as_of must be 2026-09-19");
  }
  if (!Array.isArray(doc.rows)) throw new Error("cohort rows missing");
  const seen = new Set<string>();
  const rows: PocHouseholdInput[] = [];
  for (const item of doc.rows) {
    if (!item || typeof item !== "object") throw new Error("cohort row invalid");
    const row = item as Record<string, unknown>;
    const complexId = row.complex_id;
    if (typeof complexId !== "string" || !/^cx_[0-9a-f]{16}$/.test(complexId)) {
      throw new Error("cohort complex_id invalid");
    }
    if (seen.has(complexId)) throw new Error(`duplicate complex_id ${complexId}`);
    seen.add(complexId);
    if (
      typeof row.household_count !== "number" ||
      !Number.isInteger(row.household_count) ||
      row.household_count <= 0
    ) {
      throw new Error(`household_count invalid for ${complexId}`);
    }
    if (!isConfidence(row.profile_confidence)) {
      throw new Error(`profile_confidence invalid for ${complexId}`);
    }
    if (row.cohort_origin !== POC_COHORT_ORIGIN) {
      throw new Error(`cohort_origin invalid for ${complexId}`);
    }
    if (row.profile_source !== POC_PROFILE_SOURCE) {
      throw new Error(`profile_source invalid for ${complexId}`);
    }
    if (row.profile_as_of !== POC_PROFILE_AS_OF) {
      throw new Error(`profile_as_of invalid for ${complexId}`);
    }
    rows.push({
      complexId,
      householdCount: row.household_count,
      profileConfidence: row.profile_confidence,
      profileSource: row.profile_source,
      profileAsOf: row.profile_as_of,
      cohortOrigin: POC_COHORT_ORIGIN,
    });
  }
  if (rows.length !== 25) throw new Error(`cohort must be 25 rows, got ${rows.length}`);
  return rows;
}

/**
 * Production household wins only when it equals the POC value.
 * A missing Production household uses the POC value for this sample run.
 * A different Production household is a conflict: no value is chosen.
 */
export function resolveProfileOverlay(
  poc: PocHouseholdInput,
  warehouse: WarehouseHousehold | null,
): ProfileResolution {
  const production = warehouse?.householdCount;
  if (production != null) {
    if (!Number.isInteger(production) || production !== poc.householdCount) {
      return {
        status: "PROFILE_CONFLICT",
        productionHousehold: production,
        pocHousehold: poc.householdCount,
      };
    }
    return {
      status: "PRODUCTION_MATCH",
      profile: {
        householdCount: production,
        source: warehouse?.source ?? null,
        sourceKey: warehouse?.sourceKey ?? null,
        sourceAsOf: warehouse?.sourceAsOf ?? null,
        confidence: poc.profileConfidence,
      },
    };
  }
  return {
    status: "POC_OVERLAY",
    profile: {
      householdCount: poc.householdCount,
      source: poc.profileSource,
      sourceKey: null,
      sourceAsOf: poc.profileAsOf,
      confidence: poc.profileConfidence,
    },
  };
}
