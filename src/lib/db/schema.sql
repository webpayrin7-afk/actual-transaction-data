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
  -- warehouse가 transaction identity를 처음 확보한 시각 (UTC ISO). internal audit.
  -- 삭제/rename 금지. INSERT 시 설정 후 절대 덮어쓰지 않음.
  first_seen_at TEXT,
  -- 사용자가 "새로 확인된 거래"로 볼 수 있는 시각 (UTC ISO). product activity.
  -- daily INSERT = syncedAt, backfill/correction INSERT = NULL. UPDATE 시 보존.
  -- 기존 first_seen bulk/backfill 행은 NULL이 정직한 기본값.
  discovery_at TEXT,
  -- 본문이 실제로 INSERT/UPDATE 된 마지막 시각 (UTC ISO).
  -- 동일 본문 재수집 시에는 갱신하지 않음. 현재 조회 경로에서는 미사용.
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

-- Product discovery feed (Home). Partial: NULL discovery_at rows stay out of the index.
CREATE INDEX IF NOT EXISTS idx_tx_type_discovery
  ON transactions (deal_type, discovery_at)
  WHERE discovery_at IS NOT NULL;

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


-- Phase 5 unit-type master (pilot write only; no nationwide backfill)
CREATE TABLE IF NOT EXISTS apt_complex_classifications (
  complex_key TEXT PRIMARY KEY,
  apt_name_norm TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  gu TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL,
  singoga_mode TEXT NOT NULL,
  label_confidence REAL,
  group_confidence_high INTEGER NOT NULL DEFAULT 0,
  source_phase TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apt_complex_class_name
  ON apt_complex_classifications (apt_name_norm);

CREATE TABLE IF NOT EXISTS apt_unit_types (
  unit_type_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  supply_area_sqm REAL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  household_count INTEGER,
  mapping_confidence TEXT,
  exclusive_includes_partial_common INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apt_unit_types_complex
  ON apt_unit_types (complex_key);

CREATE TABLE IF NOT EXISTS apt_pyeong_groups (
  group_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  market_label INTEGER,
  display_mode TEXT NOT NULL,
  supply_area_min REAL,
  supply_area_max REAL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  household_count INTEGER,
  confidence TEXT,
  group_confidence_high INTEGER NOT NULL DEFAULT 0,
  label_null_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apt_pyeong_groups_complex
  ON apt_pyeong_groups (complex_key);

CREATE TABLE IF NOT EXISTS apt_unit_type_group_links (
  unit_type_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  complex_key TEXT NOT NULL,
  is_outlier INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (unit_type_key, group_key)
);
CREATE INDEX IF NOT EXISTS idx_apt_unit_type_links_complex
  ON apt_unit_type_group_links (complex_key);

-- Phase 5.3b: pre-warehouse prior-max baselines (soft FK → apt_pyeong_groups.group_key).
-- Fixture/seed only until post-WH gap gate clears; no nationwide backfill.
CREATE TABLE IF NOT EXISTS apt_pyeong_group_baselines (
  group_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  baseline_until TEXT NOT NULL,
  prior_max_amount INTEGER NOT NULL,
  prior_max_deal_date TEXT,
  source TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high',
  completeness TEXT NOT NULL DEFAULT 'pre-warehouse-molit-max',
  pre_warehouse_trade_count INTEGER,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_apt_pyeong_group_baselines_complex
  ON apt_pyeong_group_baselines (complex_key);

-- BUILDING topology (see src/lib/db/migrations/20260920_complex_buildings.sql)
CREATE TABLE IF NOT EXISTS complex_buildings (
  building_id TEXT PRIMARY KEY,
  complex_id TEXT NOT NULL REFERENCES apt_complex_master(complex_id),
  official_building_key TEXT NOT NULL,
  mgm_bldrgst_pk TEXT,
  dong_label TEXT,
  dong_label_status TEXT NOT NULL,
  building_name TEXT,
  main_usage TEXT,
  main_usage_code TEXT,
  main_atch_type TEXT,
  residential_flag INTEGER NOT NULL DEFAULT 0,
  household_count INTEGER,
  floor_count INTEGER,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (official_building_key)
);
CREATE INDEX IF NOT EXISTS idx_cb_complex
  ON complex_buildings (complex_id, residential_flag);

CREATE TABLE IF NOT EXISTS complex_building_geometry (
  building_id TEXT PRIMARY KEY REFERENCES complex_buildings(building_id),
  geometry_source TEXT NOT NULL,
  centroid_lat REAL,
  centroid_lng REAL,
  representative_lat REAL,
  representative_lng REAL,
  footprint_geojson TEXT,
  source_object_id TEXT,
  source_version TEXT,
  source_as_of TEXT NOT NULL DEFAULT '',
  geometry_status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unit_type_stats (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  household_count INTEGER,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id)
);

CREATE TABLE IF NOT EXISTS unit_type_building_links (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  household_count INTEGER,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL,
  status TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id, building_id)
);

CREATE TABLE IF NOT EXISTS complex_building_parity (
  complex_id TEXT PRIMARY KEY REFERENCES apt_complex_master(complex_id),
  kapt_household_count INTEGER,
  unit_household_count INTEGER,
  type_household_sum INTEGER,
  building_household_sum INTEGER,
  parity_class TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_building_checkpoint (
  complex_id TEXT PRIMARY KEY,
  parcel_key TEXT NOT NULL DEFAULT '',
  pnu TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 9,
  title_status TEXT NOT NULL,
  building_status TEXT NOT NULL,
  geometry_status TEXT NOT NULL,
  link_status TEXT NOT NULL,
  title_total_count INTEGER NOT NULL DEFAULT 0,
  residential_count INTEGER NOT NULL DEFAULT 0,
  api_calls INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS official_building_title_cache (
  parcel_key TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (parcel_key, page_no)
);

-- BUILDING V2 (see src/lib/db/migrations/20260921_building_geometry_3d.sql)
CREATE TABLE IF NOT EXISTS building_3d_source_links (
  complex_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_complex_id TEXT NOT NULL DEFAULT '',
  provider_building_id TEXT NOT NULL DEFAULT '',
  provider_object_id TEXT NOT NULL DEFAULT '',
  geometry_version TEXT NOT NULL DEFAULT '',
  provider_geometry_version TEXT NOT NULL DEFAULT '',
  source_as_of TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'EMPTY',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (building_id, provider, provider_object_id)
);
CREATE TABLE IF NOT EXISTS building_3d_provider_capabilities (
  provider TEXT PRIMARY KEY,
  supports_footprint INTEGER,
  supports_height INTEGER,
  supports_3d_object INTEGER,
  supports_sunlight INTEGER,
  supports_datetime_shadow INTEGER,
  embed_allowed INTEGER,
  commercial_use_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  cache_allowed INTEGER,
  source_version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unit_type_household_counts (
  complex_id TEXT NOT NULL,
  unit_type_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  supply_cents INTEGER,
  household_count INTEGER,
  count_status TEXT NOT NULL,
  ui_safe INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, unit_type_id)
);
CREATE TABLE IF NOT EXISTS unit_exclusive_group_counts (
  complex_id TEXT NOT NULL,
  exclusive_cents INTEGER NOT NULL,
  household_count INTEGER,
  variant_count INTEGER NOT NULL DEFAULT 0,
  count_status TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, exclusive_cents)
);
CREATE TABLE IF NOT EXISTS gis_building_source_manifest (
  manifest_id TEXT PRIMARY KEY,
  source_dataset TEXT NOT NULL,
  source_version TEXT NOT NULL DEFAULT '',
  source_date TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  crs TEXT NOT NULL DEFAULT '',
  feature_count INTEGER,
  valid_geometry_count INTEGER,
  license_attribution TEXT NOT NULL DEFAULT '',
  wfs_fallback_used INTEGER NOT NULL DEFAULT 0,
  acquisition_status TEXT NOT NULL,
  local_path TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compact_extractor_spec (
  spec_id TEXT PRIMARY KEY,
  required INTEGER NOT NULL DEFAULT 1,
  artifact_name TEXT NOT NULL,
  expected_size TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
