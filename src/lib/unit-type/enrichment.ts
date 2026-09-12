import type { Client } from "@libsql/client";

/** Domains recognized by the incremental enrichment framework. */
export const ENRICHMENT_DOMAINS = [
  "GEO",
  "BUILDING_REGISTRY",
  "UNIT_GROUP",
  "SINGOGA_BASELINE",
  "SCHOOL",
  "FLOORPLAN",
] as const;

export type EnrichmentDomain = (typeof ENRICHMENT_DOMAINS)[number];

export const ENRICHMENT_STATUSES = [
  "READY",
  "PENDING",
  "UNRESOLVED",
  "FAILED",
  "NOT_REQUIRED",
  "STALE",
] as const;

export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];

export type EnrichmentCandidateMode =
  | "missing-only"
  | "version-refresh"
  | "full-rescan";

export type SelectEnrichmentCandidatesParams = {
  domain: EnrichmentDomain;
  /** Target data_version for version-refresh / readiness checks. */
  dataVersion: number;
  mode?: EnrichmentCandidateMode;
  /** Hard cap on returned candidates (bounded batch). */
  limit?: number;
  /** Optional explicit complex_id allowlist. */
  complexIds?: string[];
  /**
   * When true with full-rescan, include rows already READY at target version.
   * Default full-rescan still skips current READY+version matches unless forceAll.
   */
  forceAll?: boolean;
};

export type EnrichmentStateRow = {
  complexId: string;
  domain: EnrichmentDomain;
  status: EnrichmentStatus;
  reasonCode: string | null;
  dataVersion: number | null;
  processedAt: string | null;
  sourceUpdatedAt: string | null;
  updatedAt: string;
};

/**
 * Read-only candidate selection for incremental enrichment.
 *
 * A) missing-only: no enrichment row OR status != READY
 * B) version-refresh: missing OR status != READY OR data_version < target
 * C) full-rescan: all master rows (optionally forced), still bounded by limit
 *
 * Does not insert PENDING rows. Callers write final state once per complex/domain.
 */
export async function selectEnrichmentCandidates(
  db: Client,
  params: SelectEnrichmentCandidatesParams,
): Promise<string[]> {
  const mode = params.mode ?? "missing-only";
  const limit = Math.max(1, Math.min(params.limit ?? 100, 5000));
  const args: Array<string | number> = [];

  let filterSql = "";
  if (params.complexIds?.length) {
    filterSql = ` AND m.complex_id IN (${params.complexIds.map(() => "?").join(",")})`;
    args.push(...params.complexIds);
  }

  // Always scope to canonical master; held identities outside master are excluded.
  if (mode === "full-rescan" && params.forceAll) {
    const res = await db.execute({
      sql: `
        SELECT m.complex_id
        FROM apt_complex_master m
        WHERE 1=1 ${filterSql}
        ORDER BY m.complex_id
        LIMIT ?
      `,
      args: [...args, limit],
    });
    return res.rows.map((r) => String(r.complex_id));
  }

  if (mode === "full-rescan" || mode === "version-refresh") {
    // Rescan / refresh: everything not already READY at the target version.
    const res = await db.execute({
      sql: `
        SELECT m.complex_id
        FROM apt_complex_master m
        LEFT JOIN apt_complex_enrichment_state e
          ON e.complex_id = m.complex_id AND e.domain = ?
        WHERE (
          e.complex_id IS NULL
          OR e.status != 'READY'
          OR e.data_version IS NULL
          OR e.data_version < ?
        )
        ${filterSql}
        ORDER BY m.complex_id
        LIMIT ?
      `,
      args: [params.domain, params.dataVersion, ...args, limit],
    });
    return res.rows.map((r) => String(r.complex_id));
  }

  // missing-only (default): no row OR not READY (does not bump solely for version)
  const res = await db.execute({
    sql: `
      SELECT m.complex_id
      FROM apt_complex_master m
      LEFT JOIN apt_complex_enrichment_state e
        ON e.complex_id = m.complex_id AND e.domain = ?
      WHERE (e.complex_id IS NULL OR e.status != 'READY')
      ${filterSql}
      ORDER BY m.complex_id
      LIMIT ?
    `,
    args: [params.domain, ...args, limit],
  });
  return res.rows.map((r) => String(r.complex_id));
}

/** Upsert final enrichment state once per processed complex/domain (idempotent). */
export async function upsertEnrichmentState(
  db: Client,
  row: {
    complexId: string;
    domain: EnrichmentDomain;
    status: EnrichmentStatus;
    reasonCode?: string | null;
    dataVersion?: number | null;
    processedAt?: string | null;
    sourceUpdatedAt?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO apt_complex_enrichment_state (
        complex_id, domain, status, reason_code, data_version,
        processed_at, source_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(complex_id, domain) DO UPDATE SET
        status = excluded.status,
        reason_code = excluded.reason_code,
        data_version = excluded.data_version,
        processed_at = excluded.processed_at,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      row.complexId,
      row.domain,
      row.status,
      row.reasonCode ?? null,
      row.dataVersion ?? null,
      row.processedAt ?? now,
      row.sourceUpdatedAt ?? null,
      now,
    ],
  });
}

export async function getEnrichmentState(
  db: Client,
  complexId: string,
  domain: EnrichmentDomain,
): Promise<EnrichmentStateRow | null> {
  const res = await db.execute({
    sql: `SELECT * FROM apt_complex_enrichment_state WHERE complex_id = ? AND domain = ? LIMIT 1`,
    args: [complexId, domain],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0] as Record<string, unknown>;
  return {
    complexId: String(r.complex_id),
    domain: String(r.domain) as EnrichmentDomain,
    status: String(r.status) as EnrichmentStatus,
    reasonCode: r.reason_code == null ? null : String(r.reason_code),
    dataVersion: r.data_version == null ? null : Number(r.data_version),
    processedAt: r.processed_at == null ? null : String(r.processed_at),
    sourceUpdatedAt:
      r.source_updated_at == null ? null : String(r.source_updated_at),
    updatedAt: String(r.updated_at ?? ""),
  };
}
