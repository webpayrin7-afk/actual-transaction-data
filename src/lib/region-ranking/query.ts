/**
 * Read path for the Seoul launch dataset.
 * Does not score and does not contain private config.
 */

export type LaunchAreaBand = "59" | "84" | "114" | "ALL";

export type RankingReader = {
  execute(query: { sql: string; args?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type RegionTopQuery = {
  rankingRunId: string;
  regionScope: "gu" | "dong";
  regionCode: string;
  areaBand: LaunchAreaBand;
  limit?: number;
};

export async function regionTop(db: RankingReader, query: RegionTopQuery) {
  const limit = query.limit ?? 10;
  const result = await db.execute({
    sql: `SELECT r.complex_id, r."rank" AS rank, r.region_total, r.confidence_bucket,
                 r.transaction_as_of, r.public_display_metrics_json, r.eligible,
                 m.apt_name_norm
          FROM region_complex_rankings r
          LEFT JOIN apt_complex_master m ON m.complex_id = r.complex_id
          WHERE r.ranking_run_id = ?
            AND r.region_scope = ?
            AND r.region_code = ?
            AND r.area_band = ?
            AND r.period = '12M'
            AND r.eligible = 1
            AND r."rank" IS NOT NULL
          ORDER BY r."rank" ASC
          LIMIT ?`,
    args: [query.rankingRunId, query.regionScope, query.regionCode, query.areaBand, limit],
  });
  return result.rows.map((row) => ({
    complexId: String(row.complex_id),
    name: row.apt_name_norm == null ? null : String(row.apt_name_norm),
    rank: Number(row.rank),
    regionTotal: Number(row.region_total),
    confidenceBucket: row.confidence_bucket == null ? null : String(row.confidence_bucket),
    transactionAsOf: String(row.transaction_as_of),
    publicMetrics: JSON.parse(String(row.public_display_metrics_json)),
  }));
}

export type ComplexRankQuery = {
  complexId: string;
  guRankingRunId: string;
  dongRankingRunId: string;
  guCode: string;
  /** 10-digit lawd + bjdong. */
  dongCode: string;
  areaBand: LaunchAreaBand;
};

export async function complexRegionRanks(db: RankingReader, query: ComplexRankQuery) {
  const result = await db.execute({
    sql: `SELECT region_scope, "rank" AS rank, region_total, confidence_bucket, transaction_as_of,
                 public_display_metrics_json
          FROM region_complex_rankings
          WHERE complex_id = ?
            AND area_band = ?
            AND period = '12M'
            AND (
              (ranking_run_id = ? AND region_scope = 'gu' AND region_code = ?)
              OR (ranking_run_id = ? AND region_scope = 'dong' AND region_code = ?)
            )`,
    args: [
      query.complexId,
      query.areaBand,
      query.guRankingRunId,
      query.guCode,
      query.dongRankingRunId,
      query.dongCode,
    ],
  });
  const byScope = new Map(result.rows.map((row) => [String(row.region_scope), row]));
  const read = (scope: "gu" | "dong") => {
    const row = byScope.get(scope);
    if (!row || row.rank == null) return null;
    return {
      rank: Number(row.rank),
      regionTotal: Number(row.region_total),
      confidenceBucket: row.confidence_bucket == null ? null : String(row.confidence_bucket),
      transactionAsOf: String(row.transaction_as_of),
      publicMetrics: JSON.parse(String(row.public_display_metrics_json)),
    };
  };
  return { gu: read("gu"), dong: read("dong") };
}
