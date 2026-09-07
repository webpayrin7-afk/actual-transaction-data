-- MOLIT 실거래 웨어하우스 (Turso / libSQL / SQLite)

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
