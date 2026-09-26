/**
 * Read path for the Seoul launch dataset.
 * Composite and decade boards are scored at read time by Ranking V4
 * over published V3 feature snapshots; objective boards read V3 rows.
 */
import {
  RANKING_V4_VERSION,
  readRankingV4Board,
  readRankingV4BoardAtPointer,
  rerankRankingV4,
  type RankingV4Sort,
} from "./ranking-v4";

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
  query: {
    regionCode: string;
    areaBand: RegionBoardBand;
    period?: string;
    limit?: number;
    sort?: RankingV4Sort;
  },
) {
  const period = query.period ?? "12M";
  const objective = query.areaBand === "TRADE_VOLUME" || query.areaBand === "PRICE_PER_SQM";
  // 여러 구로 나뉜 시 전체("41131,41133,41135"): 구별 발행본을 모아 V4로 시 전체를 점수화한다.
  // 객관 지표 보드(V3 행)는 구 단위로만 발행돼 시 전체 보드가 없다.
  if (/^[0-9]{5}(,[0-9]{5}){1,5}$/.test(query.regionCode)) {
    const board = objective
      ? null
      : await readRankingV4Board(db, {
          regionCode: query.regionCode,
          areaBand: query.areaBand as RankingAreaBandV3,
          period,
        });
    if (!board?.published || !board.transactionAsOf) {
      return {
        published: false as const,
        rankingType: query.areaBand,
        regionScope: "gu" as const,
        regionCode: query.regionCode,
        rows: [] as Awaited<ReturnType<typeof regionTop>>,
      };
    }
    const asOf = board.transactionAsOf;
    return {
      published: true as const,
      rankingType: query.areaBand,
      regionScope: "gu" as const,
      regionCode: query.regionCode,
      transactionAsOf: asOf,
      rankingVersion: RANKING_V4_VERSION,
      period,
      regionTotal: board.rows.length,
      rows: rerankRankingV4(board.rows, query.sort ?? "composite")
        .slice(0, query.limit ?? 10)
        .map((row) => ({
          complexId: row.complexId,
          name: row.name,
          dong: row.dong,
          buildYear: row.buildYear,
          rank: row.rank,
          regionTotal: row.regionTotal,
          confidenceBucket: row.confidenceBucket,
          transactionAsOf: asOf,
          publicMetrics: {
            median_price_per_sqm: row.metrics.medianPricePerSqm,
            median_deal_amount: row.metrics.medianDealAmount,
            trade_count: row.metrics.tradeCount,
            latest_deal_date: row.metrics.latestDealDate,
          } as Record<string, unknown>,
          percentiles: row.percentiles,
        })),
    };
  }
  const regionScope = scopeOf(query.regionCode);
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
  if (query.areaBand !== "TRADE_VOLUME" && query.areaBand !== "PRICE_PER_SQM") {
    const board = await readRankingV4Board(db, {
      regionCode: query.regionCode,
      areaBand: query.areaBand,
      period,
    });
    const rows = rerankRankingV4(board.rows, query.sort ?? "composite")
      .slice(0, query.limit ?? 10)
      .map((row) => ({
      complexId: row.complexId,
      name: row.name,
      dong: row.dong,
      buildYear: row.buildYear,
      rank: row.rank,
      regionTotal: row.regionTotal,
      confidenceBucket: row.confidenceBucket,
      transactionAsOf: String(pointer.transaction_as_of),
      publicMetrics: {
        median_price_per_sqm: row.metrics.medianPricePerSqm,
        median_deal_amount: row.metrics.medianDealAmount,
        trade_count: row.metrics.tradeCount,
        latest_deal_date: row.metrics.latestDealDate,
      } as Record<string, unknown>,
      percentiles: row.percentiles,
    }));
    return {
      published: true as const,
      rankingType: query.areaBand,
      regionScope,
      regionCode: query.regionCode,
      transactionAsOf: String(pointer.transaction_as_of),
      rankingVersion: RANKING_V4_VERSION,
      period,
      regionTotal: board.rows.length,
      rows,
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
    rows: rows.map((row) => ({ ...row, percentiles: null })),
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
  const bands: RankingAreaBandV3[] =
    query.areaBand && query.areaBand !== "ALL" ? ["ALL", query.areaBand] : ["ALL"];
  // 단지 주소와 구·동 발행 포인터를 한 번에 읽는다(예전: 단지 → 포인터 → 후보 3단 왕복).
  // 포인터가 없는 칸은 LEFT JOIN이라 NULL로 오고, 단지가 없으면 행이 없다.
  const bandSlots = bands.map(() => "?").join(", ");
  const pointerJoin = (scope: "gu" | "dong", code: string) => `
    SELECT m.lawd_cd, m.bjdong_cd, m.legal_dong_name, m.apt_name,
           '${scope}' AS scope, p.area_band, p.feature_run_id, p.transaction_as_of
    FROM m LEFT JOIN region_ranking_publications p
      ON p.region_scope = '${scope}' AND p.region_code = ${code}
     AND p.area_band IN (${bandSlots}) AND p.period = '12M'`;
  const master = await db.execute({
    sql: `WITH m AS (
            SELECT lawd_cd, bjdong_cd, legal_dong_name, apt_name
            FROM apt_complex_master WHERE complex_id = ?
          )
          ${pointerJoin("gu", "m.lawd_cd")}
          UNION ALL
          ${pointerJoin("dong", "m.lawd_cd || m.bjdong_cd")}`,
    args: [query.complexId, ...bands, ...bands],
  });
  const row = master.rows[0];
  if (!row) return { found: false as const };
  const guCode = String(row.lawd_cd);
  const dongCode = `${guCode}${String(row.bjdong_cd)}`;
  const pointers = new Map<string, { featureRunId: string; transactionAsOf: string }>();
  for (const item of master.rows) {
    if (item.area_band == null || item.feature_run_id == null) continue;
    pointers.set(`${String(item.area_band)}:${String(item.scope)}`, {
      featureRunId: String(item.feature_run_id),
      transactionAsOf: String(item.transaction_as_of),
    });
  }
  // 후보·점수는 발행 피처 런 ID 기준 인스턴스 캐시 — 발행이 바뀌면 키도 바뀐다.
  const boards = await Promise.all(
    bands.flatMap((band) =>
      (["gu", "dong"] as const).map(async (scope) => {
        const pointer = pointers.get(`${band}:${scope}`);
        const regionCode = scope === "gu" ? guCode : dongCode;
        return {
          key: `${band}:${scope}`,
          board: /^[0-9]{5}([0-9]{5})?$/.test(regionCode)
            ? await readRankingV4BoardAtPointer(db, {
                regionScope: scope,
                regionCode,
                areaBand: band,
                featureRunId: pointer?.featureRunId ?? null,
                transactionAsOf: pointer?.transactionAsOf ?? null,
              })
            : null,
        };
      }),
    ),
  );
  const byKey = new Map(boards.map((item) => [item.key, item.board]));
  const read = (band: RankingAreaBandV3, scope: "gu" | "dong") => {
    const board = byKey.get(`${band}:${scope}`);
    if (!board || !board.featureRunId) {
      return { published: false as const, status: "unavailable" as const };
    }
    const hit = board.rows.find((item) => item.complexId === query.complexId);
    if (!hit) {
      return {
        published: true as const,
        status: "not_ranked" as const,
        transactionAsOf: String(board.transactionAsOf),
        rankingVersion: RANKING_V4_VERSION,
      };
    }
    return {
      published: true as const,
      status: "ranked" as const,
      rank: hit.rank,
      regionTotal: hit.regionTotal,
      confidenceBucket: hit.confidenceBucket,
      transactionAsOf: String(board.transactionAsOf),
      rankingVersion: RANKING_V4_VERSION,
      publicMetrics: {
        median_price_per_sqm: hit.metrics.medianPricePerSqm,
        median_deal_amount: hit.metrics.medianDealAmount,
        trade_count: hit.metrics.tradeCount,
        latest_deal_date: hit.metrics.latestDealDate,
      } as Record<string, unknown>,
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
