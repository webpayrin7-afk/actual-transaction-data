/**
 * Read path for the Seoul launch dataset.
 * Does not score and does not contain private config.
 */

export type LaunchAreaBand = "59" | "84" | "114" | "ALL";
export type RankingAreaBandV3 =
  | LaunchAreaBand
  | "10"
  | "20"
  | "30"
  | "40"
  | "50"
  | "60"
  | "70"
  | "80"
  | "90"
  | "100";

export type RankingReader = {
  execute(query: {
    sql: string;
    args?: Array<string | number | bigint | boolean | null>;
  }): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type RegionBoardBand = RankingAreaBandV3 | "TRADE_VOLUME" | "PRICE_PER_SQM";

export type RegionTopQuery = {
  rankingRunId: string;
  regionScope: "gu" | "dong";
  regionCode: string;
  areaBand: RegionBoardBand;
  period?: string;
  limit?: number;
};

export async function regionTop(db: RankingReader, query: RegionTopQuery) {
  const limit = query.limit ?? 10;
  const result = await db.execute({
    sql: `SELECT r.complex_id, r."rank" AS rank, r.region_total, r.confidence_bucket,
                 r.transaction_as_of, r.public_display_metrics_json, r.eligible,
                 m.apt_name, m.apt_name_norm, m.legal_dong_name,
                 p.approval_date
          FROM region_complex_rankings r
          LEFT JOIN apt_complex_master m ON m.complex_id = r.complex_id
          LEFT JOIN apt_complex_profile p ON p.complex_id = r.complex_id
          WHERE r.ranking_run_id = ?
            AND r.region_scope = ?
            AND r.region_code = ?
            AND r.area_band = ?
            AND r.period = ?
            AND r.eligible = 1
            AND r."rank" IS NOT NULL
          ORDER BY r."rank" ASC
          LIMIT ?`,
    args: [query.rankingRunId, query.regionScope, query.regionCode, query.areaBand, query.period ?? "12M", limit],
  });
  return result.rows.map((row) => {
    const approval = row.approval_date == null ? null : String(row.approval_date);
    const yearMatch = approval ? /^(\d{4})/.exec(approval) : null;
    return {
      complexId: String(row.complex_id),
      name: row.apt_name == null
        ? (row.apt_name_norm == null ? null : String(row.apt_name_norm))
        : String(row.apt_name),
      dong: row.legal_dong_name == null ? null : String(row.legal_dong_name),
      buildYear: yearMatch ? Number(yearMatch[1]) : null,
      rank: Number(row.rank),
      regionTotal: Number(row.region_total),
      confidenceBucket: row.confidence_bucket == null ? null : String(row.confidence_bucket),
      transactionAsOf: String(row.transaction_as_of),
      publicMetrics: JSON.parse(String(row.public_display_metrics_json)),
    };
  });
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

function scopeOf(regionCode: string): "gu" | "dong" | null {
  if (/^[0-9]{5}$/.test(regionCode)) return "gu";
  if (/^[0-9]{10}$/.test(regionCode)) return "dong";
  return null;
}

export async function publishedRegionRanking(
  db: RankingReader,
  query: { regionCode: string; areaBand: RegionBoardBand; period?: string; limit?: number },
) {
  const regionScope = scopeOf(query.regionCode);
  const period = query.period ?? "12M";
  if (!regionScope) return { published: false as const, reason: "bad_region" };
  const pub = await db.execute({
    sql: `SELECT active_ranking_run_id, ranking_version, transaction_as_of
          FROM region_ranking_publications
          WHERE region_scope = ? AND region_code = ? AND area_band = ? AND period = ?`,
    args: [regionScope, query.regionCode, query.areaBand, period],
  });
  const pointer = pub.rows[0];
  if (!pointer) {
    return {
      published: false as const,
      rankingType: query.areaBand,
      regionScope,
      regionCode: query.regionCode,
      rows: [] as Awaited<ReturnType<typeof regionTop>>,
    };
  }
  const rows = await regionTop(db, {
    rankingRunId: String(pointer.active_ranking_run_id),
    regionScope,
    regionCode: query.regionCode,
    areaBand: query.areaBand,
    period,
    limit: query.limit,
  });
  return {
    published: true as const,
    rankingType: query.areaBand,
    regionScope,
    regionCode: query.regionCode,
    transactionAsOf: String(pointer.transaction_as_of),
    rankingVersion: String(pointer.ranking_version),
    period,
    regionTotal: rows[0]?.regionTotal ?? 0,
    rows,
  };
}

export async function objectiveMetricsByComplex(
  db: RankingReader,
  transactionAsOf: string,
  complexIds: readonly string[],
) {
  const out = new Map<string, { tradeCount3m: number; medianPricePerSqm3m: number | null }>();
  if (complexIds.length === 0) return out;
  const pointer = await db.execute({
    sql: `SELECT feature_run_id FROM region_ranking_publications
          WHERE area_band = 'TRADE_VOLUME' AND period = '3M' AND transaction_as_of = ?
          LIMIT 1`,
    args: [transactionAsOf],
  });
  const runId = pointer.rows[0]?.feature_run_id;
  if (runId == null) return out;
  for (let i = 0; i < complexIds.length; i += 80) {
    const slice = complexIds.slice(i, i + 80);
    const result = await db.execute({
      sql: `SELECT complex_id, trade_count_3m, median_price_per_sqm_3m
            FROM region_objective_metrics
            WHERE metric_run_id = ? AND complex_id IN (${slice.map(() => "?").join(",")})`,
      args: [String(runId), ...slice],
    });
    for (const row of result.rows) {
      out.set(String(row.complex_id), {
        tradeCount3m: Number(row.trade_count_3m),
        medianPricePerSqm3m: row.median_price_per_sqm_3m == null ? null : Number(row.median_price_per_sqm_3m),
      });
    }
  }
  return out;
}

export async function publishedComplexPosition(
  db: RankingReader,
  query: { complexId: string; areaBand?: RankingAreaBandV3 | null },
) {
  const master = await db.execute({
    sql: `SELECT lawd_cd, bjdong_cd, legal_dong_name, apt_name
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [query.complexId],
  });
  const row = master.rows[0];
  if (!row) return { found: false as const };
  const guCode = String(row.lawd_cd);
  const dongCode = `${guCode}${String(row.bjdong_cd)}`;
  const bands: RankingAreaBandV3[] =
    query.areaBand && query.areaBand !== "ALL" ? ["ALL", query.areaBand] : ["ALL"];
  const result = await db.execute({
    sql: `SELECT p.area_band, p.region_scope, p.ranking_version, p.transaction_as_of,
                 r."rank" AS rank, r.region_total, r.confidence_bucket, r.public_display_metrics_json
          FROM region_ranking_publications p
          LEFT JOIN region_complex_rankings r
            ON r.ranking_run_id = p.active_ranking_run_id
           AND r.region_scope = p.region_scope
           AND r.region_code = p.region_code
           AND r.area_band = p.area_band
           AND r.period = p.period
           AND r.complex_id = ?
           AND r.eligible = 1
          WHERE p.period = '12M'
            AND p.area_band IN (${bands.map(() => "?").join(",")})
            AND (
              (p.region_scope = 'gu' AND p.region_code = ?)
              OR (p.region_scope = 'dong' AND p.region_code = ?)
            )`,
    args: [query.complexId, ...bands, guCode, dongCode],
  });
  const byKey = new Map(result.rows.map((item) => [`${item.area_band}:${item.region_scope}`, item]));
  const read = (band: RankingAreaBandV3, scope: "gu" | "dong") => {
    const got = byKey.get(`${band}:${scope}`);
    if (!got) return { published: false as const, status: "unavailable" as const };
    if (got.rank == null) {
      return {
        published: true as const,
        status: "not_ranked" as const,
        transactionAsOf: String(got.transaction_as_of),
        rankingVersion: String(got.ranking_version),
      };
    }
    return {
      published: true as const,
      status: "ranked" as const,
      rank: Number(got.rank),
      regionTotal: Number(got.region_total),
      confidenceBucket: got.confidence_bucket == null ? null : String(got.confidence_bucket),
      transactionAsOf: String(got.transaction_as_of),
      rankingVersion: String(got.ranking_version),
      publicMetrics: JSON.parse(String(got.public_display_metrics_json)),
    };
  };
  return {
    found: true as const,
    complexId: query.complexId,
    aptName: row.apt_name == null ? null : String(row.apt_name),
    dongName: row.legal_dong_name == null ? null : String(row.legal_dong_name),
    guCode,
    dongCode,
    positions: bands.map((band) => ({
      areaBand: band,
      gu: read(band, "gu"),
      dong: read(band, "dong"),
    })),
  };
}
