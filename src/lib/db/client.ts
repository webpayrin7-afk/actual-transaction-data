import { createClient, type Client } from "@libsql/client";

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
`);
}
