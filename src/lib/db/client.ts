import { createClient, type Client } from "@libsql/client";
import {
  resetDiscoveryAtColumnCache,
  shouldMigrateDiscoveryAtColumn,
} from "@/lib/db/discovery-axis";

let client: Client | null | undefined;

/** Turso 또는 로컬 file: SQLite. 미설정 시 null (라이브 MOLIT 폴백) */
export function getDb(): Client | null {
  if (client !== undefined) return client;

  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) {
    client = null;
    return client;
  }

  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  // file: 로컬 DB는 토큰 불필요
  if (!url.startsWith("file:") && !authToken) {
    console.warn("[db] TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing");
    client = null;
    return client;
  }

  client = createClient({
    url,
    authToken: authToken || undefined,
  });
  return client;
}

export function hasDb(): boolean {
  return getDb() !== null;
}

export async function ensureSchema(db: Client = getDb()!): Promise<void> {
  try {
    await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS sync_months (
  lawd_cd TEXT NOT NULL,
  year_month TEXT NOT NULL,
  deal_kind TEXT NOT NULL CHECK (deal_kind IN ('trade', 'rent')),
  synced_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lawd_cd, year_month, deal_kind)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  lawd_cd TEXT NOT NULL,
  year_month TEXT NOT NULL,
  deal_type TEXT NOT NULL CHECK (deal_type IN ('trade', 'rent')),
  deal_date TEXT NOT NULL,
  apt_name TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  gu TEXT NOT NULL DEFAULT '',
  dong TEXT NOT NULL DEFAULT '',
  exclusive_area REAL NOT NULL DEFAULT 0,
  deal_amount INTEGER NOT NULL DEFAULT 0,
  monthly_rent INTEGER NOT NULL DEFAULT 0,
  floor INTEGER NOT NULL DEFAULT 0,
  build_year INTEGER,
  jibun TEXT NOT NULL DEFAULT '',
  dealing_gbn TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tx_lawd_apt_ym
  ON transactions (lawd_cd, apt_name_norm, year_month);

CREATE INDEX IF NOT EXISTS idx_tx_lawd_ym_type
  ON transactions (lawd_cd, year_month, deal_type);

CREATE INDEX IF NOT EXISTS idx_tx_apt_norm
  ON transactions (apt_name_norm);

CREATE TABLE IF NOT EXISTS apt_catalog (
  apt_name_norm TEXT NOT NULL,
  apt_name TEXT NOT NULL,
  gu TEXT NOT NULL,
  dong TEXT NOT NULL DEFAULT '',
  deal_count INTEGER NOT NULL DEFAULT 0,
  max_deal_amount INTEGER NOT NULL DEFAULT 0,
  latest_deal_date TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (apt_name_norm, gu)
);

CREATE INDEX IF NOT EXISTS idx_apt_catalog_norm
  ON apt_catalog (apt_name_norm);

CREATE TABLE IF NOT EXISTS market_home_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  as_of_date TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_type_deal_date
  ON transactions (deal_type, deal_date);

CREATE TABLE IF NOT EXISTS market_stats_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  singoga_count INTEGER NOT NULL DEFAULT 0,
  drop_count INTEGER NOT NULL DEFAULT 0,
  median_amount INTEGER,
  avg_amount INTEGER,
  median_ppsqm REAL,
  PRIMARY KEY (day, scope)
);

CREATE INDEX IF NOT EXISTS idx_stats_daily_scope_day
  ON market_stats_daily (scope, day);

CREATE TABLE IF NOT EXISTS market_stats_daily_region (
  day TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  metro TEXT NOT NULL,
  region_slug TEXT NOT NULL DEFAULT '',
  region_name TEXT NOT NULL DEFAULT '',
  trade_count INTEGER NOT NULL DEFAULT 0,
  singoga_count INTEGER NOT NULL DEFAULT 0,
  drop_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, lawd_cd)
);

CREATE INDEX IF NOT EXISTS idx_stats_region_day_metro
  ON market_stats_daily_region (metro, day);

CREATE TABLE IF NOT EXISTS market_stats_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  as_of_date TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT '',
  hist_from TEXT NOT NULL DEFAULT '',
  stats_from TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS market_stats_feeds (
  period TEXT NOT NULL,
  scope TEXT NOT NULL,
  as_of_date TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT '',
  complex_key_version TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  PRIMARY KEY (period, scope)
);
`);

    // 기존 DB에 audit 시간축 컬럼 추가 (legacy는 NULL 유지 — migration 시각으로 채우지 않음)
    await ensureColumn(db, "transactions", "first_seen_at", "TEXT");
    await ensureColumn(db, "transactions", "last_seen_at", "TEXT");
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_tx_type_first_seen
       ON transactions (deal_type, first_seen_at)`,
    );
    // discovery_at: local file tests / explicit opt-in only.
    // Do not ALTER production Turso from a normal app/sync boot.
    if (shouldMigrateDiscoveryAtColumn()) {
      await ensureColumn(db, "transactions", "discovery_at", "TEXT");
      resetDiscoveryAtColumnCache();
    }
    // Home discovery range. IF NOT EXISTS is a no-op once D3 built it on Turso.
    const txCols = await db.execute("PRAGMA table_info(transactions)");
    if (txCols.rows.some((row) => String(row.name) === "discovery_at")) {
      await db.execute(`
CREATE INDEX IF NOT EXISTS idx_tx_type_discovery
  ON transactions (deal_type, discovery_at)
  WHERE discovery_at IS NOT NULL;
`);
    }
  } catch (err) {
    // Turso write 차단 시에도 기존 테이블 조회는 가능해야 함
    const msg = err instanceof Error ? err.message : String(err);
    if (/BLOCKED|write operations are forbidden|READONLY/i.test(msg)) {
      console.warn("[db] ensureSchema skipped (writes blocked):", msg);
      return;
    }
    throw err;
  }
}

async function ensureColumn(
  db: Client,
  table: string,
  column: string,
  sqlType: string,
): Promise<void> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((row) => String(row.name) === column);
  if (exists) return;
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}
