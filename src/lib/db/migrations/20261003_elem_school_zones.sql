-- 초등학교 통학구역 · 배정 초등학교 · 단지 → 통학구역. New tables only. 값은 원문 그대로 (추정값 없음).
-- elem_school_zones 원천: 한국지방교육행정연구재단·한국교육시설안전원 초등학교통학구역 SHP (BASE_DT 2025-09-22, EPSG:5186).
--   zone_id = HAKGUDO_ID. zone_kind: HAKGUDO_GB '0' → single(통학구역), '1' → joint(공동통학구역).
--   geojson = WGS84로 옮기고 약 5~10m 허용오차로 단순화한 Polygon/MultiPolygon (지도 표시용). bbox = [서,남,동,북].
--   먼저 서울(11)·경기(41)만, 나머지 시도는 같은 스크립트로 --sd 만 바꿔 더한다.
-- elem_school_zone_schools 원천: 전국학교학구도연계정보표준데이터 (2026-03-20). 학구ID → 학교ID(B…)·학교명.
--   school_code = school_master.school_code (학교명 + 시도코드 정확 일치, 같으면 시군구·운영 중으로만 가림). 못 찾으면 NULL.
-- complex_elem_school_zones: 단지 지도 좌표(complex_map_anchor, 없으면 apt_complex_master) 가 원본 도형(단순화 전) 안에 드는 통학구역.
--   한 단지가 통학구역 하나 + 공동통학구역에 함께 들 수 있다. 어느 구역에도 들지 않으면 행이 없다.
CREATE TABLE IF NOT EXISTS elem_school_zones (
  zone_id TEXT PRIMARY KEY,
  zone_name TEXT NOT NULL,
  zone_kind TEXT NOT NULL,
  hakgudo_gb TEXT NOT NULL,
  sd_cd TEXT NOT NULL,
  sgg_cd TEXT,
  edu_office TEXT,
  bbox TEXT NOT NULL,
  geojson TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  simplify_m REAL NOT NULL,
  upd_dt TEXT,
  base_date TEXT NOT NULL,
  source TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elem_school_zones_sd ON elem_school_zones (sd_cd);

CREATE TABLE IF NOT EXISTS elem_school_zone_schools (
  zone_id TEXT NOT NULL,
  facility_school_id TEXT NOT NULL,
  school_name TEXT NOT NULL,
  school_code TEXT,
  base_date TEXT NOT NULL,
  source TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  PRIMARY KEY (zone_id, facility_school_id)
);

CREATE TABLE IF NOT EXISTS complex_elem_school_zones (
  complex_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_kind TEXT NOT NULL,
  point_lat REAL NOT NULL,
  point_lng REAL NOT NULL,
  point_source TEXT NOT NULL,
  zone_base_date TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, zone_id)
);
