-- 신고가 · 하락 거래 기록 (시장 > 신고가·하락 거래 페이지).
-- New table only. Rows are derived from transactions; nothing else is altered.
--
-- One row per trade that, on the day ZIPLAB first saw it (seen_date, KST, from discovery_at
-- or first_seen_at), was either
--   singoga: deal_amount > the highest earlier trade of the same complex·법정동·전용면적(0.01㎡)
--   drop:    deal_amount <= that earlier high × 0.9
-- "Earlier" = deal_date strictly before this trade's deal_date (same rule as the market home).
-- prior_max_date = contract date of that earlier high (for "N년 만의 신고가" / "고점 대비").
-- rule_version bumps if the rule changes; rows of an older version stay until rebuilt.
CREATE TABLE IF NOT EXISTS market_price_moves (
  tx_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('singoga', 'drop')),
  seen_date TEXT NOT NULL,
  deal_date TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  apt_name TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  gu TEXT NOT NULL DEFAULT '',
  dong TEXT NOT NULL DEFAULT '',
  exclusive_area REAL NOT NULL,
  floor INTEGER,
  deal_amount INTEGER NOT NULL,
  prior_max_amount INTEGER NOT NULL,
  prior_max_date TEXT,
  change_amount INTEGER NOT NULL,
  change_pct REAL NOT NULL,
  rule_version TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_moves_seen_kind ON market_price_moves (seen_date, kind);
CREATE INDEX IF NOT EXISTS idx_price_moves_lawd_seen ON market_price_moves (lawd_cd, seen_date);
