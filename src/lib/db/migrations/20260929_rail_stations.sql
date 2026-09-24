-- 전국 도시철도 역 (단지 상세 주변 교통 · 3D 주변). New table only.
-- 원천: 공공데이터포털 전국도시철도역사정보표준데이터 (XLSX), 값은 원문 그대로. 좌표는 원천 역위도·역경도.
-- station_key = 역번호|노선번호|노선명 (같은 역번호·노선번호에 노선명이 다른 행이 있어 셋을 묶는다).
CREATE TABLE IF NOT EXISTS rail_stations (
  station_key TEXT PRIMARY KEY,
  station_no TEXT NOT NULL,
  name TEXT NOT NULL,
  line_no TEXT,
  line_name TEXT NOT NULL,
  transfer_type TEXT,
  transfer_lines TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  operator TEXT,
  road_address TEXT,
  base_date TEXT,
  source TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rail_stations_lat_lng ON rail_stations (lat, lng);
