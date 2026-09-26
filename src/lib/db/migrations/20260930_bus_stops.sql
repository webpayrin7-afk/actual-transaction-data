-- 전국 버스정류장 위치 · 서울 노선별 정류소. New tables only. 값은 원문 그대로.
-- bus_stops 원천: 국토교통부 전국 버스정류장 위치정보 (2025-10-31, CSV cp949). stop_id = 정류장번호.
--   위도·경도가 비었거나 숫자가 아니거나 한국 범위(33~39, 124~132) 밖이면 적재하지 않는다.
--   ars_no = 모바일단축번호 원문 — 서울 일부는 원천에서 앞자리 0이 빠져 있다(예: 8832 ↔ 노선 파일 08832).
-- bus_stop_routes 원천: 서울시 버스노선별 정류소정보 (2026-09-02, XLSX). 한 노선의 순번마다 한 행.
--   ars_id = ARS_ID 원문(5자리, 앞자리 0 유지). bus_stops 와는 ars_id = ars_no 정확 일치로만 잇는다.
CREATE TABLE IF NOT EXISTS bus_stops (
  stop_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  collected_date TEXT,
  ars_no TEXT,
  city_code TEXT,
  city_name TEXT,
  manager_city TEXT,
  source TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bus_stops_lat_lng ON bus_stops (lat, lng);
CREATE INDEX IF NOT EXISTS idx_bus_stops_ars_no ON bus_stops (ars_no);

CREATE TABLE IF NOT EXISTS bus_stop_routes (
  route_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  route_no TEXT NOT NULL,
  node_id TEXT,
  ars_id TEXT,
  stop_name TEXT,
  base_date TEXT NOT NULL,
  source TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  PRIMARY KEY (route_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_bus_stop_routes_ars_id ON bus_stop_routes (ars_id);
