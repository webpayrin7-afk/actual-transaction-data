-- 3D 단지 탐색 — 국토교통부 GIS건물통합정보(CH_D010) 사본. New table only.
-- gis_buildings: 건물 외곽선(WGS84, 0.3m 단순화)·높이·층수 등 원천 그대로. 단지 주변(반경 400m)만 적재한다.
-- 단지 동과의 연결은 기존 complex_buildings(건축HUB 표제부 기반)의 mgm_bldrgst_pk = gis_buildings.bldrgst_pk
-- (건축물대장 관리번호, 원천 A19) 정확 일치로 읽을 때 한다 — 별도 연결 테이블 없음.
CREATE TABLE IF NOT EXISTS gis_buildings (
  bld_key TEXT PRIMARY KEY,
  bldrgst_pk TEXT,
  pnu TEXT,
  bjdong_cd TEXT,
  lawd_cd TEXT,
  name TEXT,
  dong_name TEXT,
  use_code TEXT,
  use_name TEXT,
  structure TEXT,
  height_m REAL,
  floors_above INTEGER,
  floors_below INTEGER,
  building_area REAL,
  total_floor_area REAL,
  approval_date TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  rings TEXT NOT NULL,
  source_date TEXT,
  change_type TEXT,
  payload_hash TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gis_buildings_pnu ON gis_buildings (pnu);
CREATE INDEX IF NOT EXISTS idx_gis_buildings_lat_lng ON gis_buildings (lat, lng);
CREATE INDEX IF NOT EXISTS idx_gis_buildings_bldrgst ON gis_buildings (bldrgst_pk);
