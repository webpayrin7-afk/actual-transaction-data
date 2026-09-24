-- 지도 지역 경계 (구·동 상세 버튼과 함께 그리는 범위). New table only.
-- 원천: 국토지리정보원 수치지도 행정경계 N3A_G0100000(시군구) · N3A_G0110000(읍면동, 법정동), EPSG:5179 → WGS84.
-- code = 법정동코드 10자리(시군구는 뒤 5자리 00000). rings = [[[lng,lat],…],…] 외곽선만, 단순화(시군구 60m · 읍면동 20m).
CREATE TABLE IF NOT EXISTS map_boundaries (
  code TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('gu', 'dong')),
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  rings TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_boundaries_level_name ON map_boundaries (level, name);
