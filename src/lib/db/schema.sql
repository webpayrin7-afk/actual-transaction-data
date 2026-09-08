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
  dealing_gbn TEXT NOT NULL DEFAULT '',
  -- 시스템 최초/마지막 확인 시각 (UTC ISO). legacy는 NULL.
  -- 신고일/공개일이 아님.
  first_seen_at TEXT,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_lawd_apt_ym
  ON transactions (lawd_cd, apt_name_norm, year_month);

CREATE INDEX IF NOT EXISTS idx_tx_lawd_ym_type
  ON transactions (lawd_cd, year_month, deal_type);

CREATE INDEX IF NOT EXISTS idx_tx_apt_norm
  ON transactions (apt_name_norm);

-- 자동완성용 단지 디렉터리 (적재 시 갱신)
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

-- 시장 홈 사전 집계 스냅샷 (sync/db:market 후 갱신)
CREATE TABLE IF NOT EXISTS market_home_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  as_of_date TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_type_deal_date
  ON transactions (deal_type, deal_date);

CREATE INDEX IF NOT EXISTS idx_tx_type_first_seen
  ON transactions (deal_type, first_seen_at);

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
