-- Additive commerce (상권) snapshots — national rollout of the 잠실엘스 pilot.
-- New tables only. Does not alter complex_living_* or any other existing table.
--
-- Source: 소상공인시장진흥공단_상가(상권)정보 (data.go.kr 15083033), one file per quarter.
-- Population: P0 = all stores with valid coordinates; P2 = daily_commerce_core_v1
--   (c1b_frozen_p2_v1: LCLS I2/G2/Q1/R1 + MCLS P105/P106/S201..S209).
-- Distance: straight-line haversine (R = 6,371,000m) from the complex center.
-- Center: complex_map_anchor (NAVER geocode) first, else apt_complex_master lat/lng.
-- Complexes without any coordinate get NO rows (never a zero row).
-- A new SEMAS quarter is a new source_version; older versions stay.

-- One row per complex × radius (500, 1000).
-- composition_json: JSON int array, bucket order commerce_bucket_v1 =
--   [음식/외식, 쇼핑/소매, 생활서비스, 교육, 여가/체육, 의료/건강, 기타]  (P2 counts)
-- facilities_json: JSON int array, facility order commerce_facility_v1 =
--   [병원/의원, 약국, 편의점, 마트/슈퍼, 카페, 음식점, 미용, 학원, 체육]  (P0 counts)
CREATE TABLE IF NOT EXISTS complex_commerce_snapshots (
  complex_id TEXT NOT NULL,
  radius_m INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  population_version TEXT NOT NULL,
  population_rule_version TEXT NOT NULL,
  p0_total INTEGER NOT NULL CHECK (p0_total >= 0),
  p2_total INTEGER NOT NULL CHECK (p2_total >= 0),
  composition_json TEXT NOT NULL,
  facilities_json TEXT NOT NULL,
  center_lat REAL NOT NULL,
  center_lng REAL NOT NULL,
  coordinate_source TEXT NOT NULL,
  distance_metric TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  built_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, source_version, snapshot_version, radius_m)
);

-- P2 store points bucketed in 0.01° × 0.01° grid cells (≈1.1km × 0.9km).
-- cell_key = floor(lat*100) * 100000 + floor(lng*100).
-- points_json: flattened [dLatE6, dLngE6, bucketIdx, ...] where
--   lat = (floor(lat*100)*10000 + dLatE6) / 1e6, same for lng; bucketIdx ∈ 0..5
--   in commerce_bucket_v1 order. No business name / id / address is stored.
-- Only cells within 1km-query reach of at least one complex center are stored.
CREATE TABLE IF NOT EXISTS commerce_point_cells (
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  cell_key INTEGER NOT NULL,
  point_count INTEGER NOT NULL CHECK (point_count >= 0),
  points_json TEXT NOT NULL,
  PRIMARY KEY (source_version, snapshot_version, cell_key)
);

CREATE TABLE IF NOT EXISTS complex_commerce_publications (
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  population_version TEXT NOT NULL,
  population_rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  built_at TEXT NOT NULL,
  complex_count INTEGER NOT NULL,
  cell_count INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (source_version, snapshot_version)
);
