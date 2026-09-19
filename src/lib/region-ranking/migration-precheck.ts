/**
 * Static checks for the ranking foundation migration.
 * A failure here must block Production apply.
 */

export const FEATURE_TABLE = "ranking_feature_snapshots";
export const RANKING_TABLE = "region_complex_rankings";

export const FEATURE_COLUMNS = [
  "feature_run_id",
  "complex_id",
  "lawd_cd",
  "bjdong_cd",
  "area_band",
  "area_band_version",
  "period",
  "transaction_as_of",
  "source_window_start",
  "source_window_end",
  "recent_window_start",
  "recent_window_end",
  "previous_window_start",
  "previous_window_end",
  "median_price_per_sqm",
  "median_deal_amount",
  "trade_count",
  "household_count",
  "turnover",
  "active_month_count",
  "latest_deal_date",
  "recent_3m_trade_count",
  "previous_3m_trade_count",
  "recent_3m_median_price_per_sqm",
  "previous_3m_median_price_per_sqm",
  "feature_version",
  "profile_source",
  "profile_confidence",
  "eligible_input",
  "exclusion_reason",
  "calculated_at",
] as const;

export const RANKING_COLUMNS = [
  "ranking_run_id",
  "region_scope",
  "region_code",
  "complex_id",
  "area_band",
  "period",
  "feature_run_id",
  "rank",
  "region_total",
  "confidence_bucket",
  "eligible",
  "exclusion_reason",
  "ranking_version",
  "transaction_as_of",
  "calculated_at",
  "public_display_metrics_json",
] as const;

export const RANKING_INDEXES = [
  "idx_rfs_feature_lawd",
  "idx_rfs_feature_dong",
  "idx_rcr_feature_run",
  "idx_rcr_region_lookup",
] as const;

const FORBIDDEN = /\b(DROP|DELETE|UPDATE|ALTER|INSERT|REPLACE|TRUNCATE|PRAGMA)\b/i;
const FORBIDDEN_COLUMN = /\b(weight|threshold|percentile|component_score|private_config)\b/i;

export type PrecheckResult = { ok: true; statements: string[] } | { ok: false; reason: string };

function tableBody(sql: string, table: string): string | null {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = sql.indexOf(marker);
  if (start < 0) return null;
  const open = sql.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

function sqlWithoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function columnNames(body: string): string[] {
  const names: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim().replace(/,$/, "");
    if (!line || line.startsWith("--") || line.startsWith("PRIMARY KEY") || line.startsWith("CHECK")) continue;
    const match = /^"?([a-z0-9_]+)"?\s+/i.exec(line);
    if (match) names.push(match[1]!.toLowerCase());
  }
  return names;
}

export function migrationStatements(sql: string): string[] {
  const parts = sql.split(";").map((part) =>
    part
      .split("\n")
      .filter((line) => !line.trim().startsWith("--") && line.trim() !== "")
      .join("\n")
      .trim(),
  );
  return parts.filter((part) => part.length > 0);
}

export function precheckRankingMigrationSql(sql: string): PrecheckResult {
  const executable = sqlWithoutComments(sql);
  if (FORBIDDEN.test(executable)) return { ok: false, reason: "destructive or mutating statement" };
  if (FORBIDDEN_COLUMN.test(executable)) return { ok: false, reason: "proprietary column" };
  const statements = migrationStatements(sql);
  if (statements.length === 0) return { ok: false, reason: "no statements" };
  for (const statement of statements) {
    if (!/^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(statement)) {
      return { ok: false, reason: "statement is not additive create-if-not-exists" };
    }
  }
  const featureBody = tableBody(sql, FEATURE_TABLE);
  const rankingBody = tableBody(sql, RANKING_TABLE);
  if (!featureBody || !rankingBody) return { ok: false, reason: "missing table" };
  if (featureBody.includes("region_scope") || featureBody.includes("ranking_version")) {
    return { ok: false, reason: "feature table mixes ranking identity" };
  }
  const featureCols = columnNames(featureBody);
  const rankingCols = columnNames(rankingBody);
  if (featureCols.join(",") !== FEATURE_COLUMNS.join(",")) {
    return { ok: false, reason: `feature columns ${featureCols.join(",")}` };
  }
  if (rankingCols.join(",") !== RANKING_COLUMNS.join(",")) {
    return { ok: false, reason: `ranking columns ${rankingCols.join(",")}` };
  }
  if (!featureBody.includes("PRIMARY KEY (feature_run_id, complex_id, area_band, period)")) {
    return { ok: false, reason: "feature primary key" };
  }
  if (!rankingBody.includes("feature_run_id")) return { ok: false, reason: "missing feature_run reference" };
  if (!rankingBody.includes("ranking_run_id") || !rankingBody.includes("region_scope")) {
    return { ok: false, reason: "ranking primary key" };
  }
  for (const indexName of RANKING_INDEXES) {
    if (!sql.includes(`CREATE INDEX IF NOT EXISTS ${indexName}`)) {
      return { ok: false, reason: `missing index ${indexName}` };
    }
  }
  return { ok: true, statements };
}
