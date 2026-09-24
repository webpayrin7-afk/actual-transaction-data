-- 서울 정비구역 경계 · 정비사업 추진현황 · 연결. New tables only.
-- 원천 A: 서울시 UPIS 의제처리구역 UPIS_C_UQ181 (2026-09), Korean 1985 Modified Central Belt(Bessel, towgs84) → WGS84.
--   zone_id = PRESENT_SN(도형번호). 원천에 같은 도형번호의 똑같은 행이 겹쳐 있어 하나만 두고,
--   같은 도형번호에 내용이 다른 행은 zone_id = PRESENT_SN:WTNNC_SN(조서번호).
--   category_code = ATRB_SE(최종코드), category_name = 원천 레이어표 이름(레이어표에 없는 코드는 NULL,
--   단 UQ1811~1814는 해당 코드 구역명 전부가 같은 사업 이름이라 그 이름).
--   gu = 대표점(representative point, 폴리곤 안 보장)이 들어가는 자치구(국토지리정보원 N3A_G0100000, 단순화 전 경계).
--   notice_date = NTFC_SN(고시번호)에 담긴 날짜 YYYYMMDD (없거나 날짜가 아니면 NULL). area_m2 = DGM_AR 원문.
--   rings = [[[lng,lat],…],…] 외곽선만, 20m 단순화.
-- 원천 B: 서울시 정비사업 추진현황 (2026-06-30 기준) XLSX. 날짜는 엑셀 일련번호 → YYYY-MM-DD, 나머지 원문.
-- redev_links: project_zone = 같은 자치구 + 구역명 정규화 정확 일치(method 'name'),
--   아니면 위치1 NAVER 지오코딩 점이 들어가는 정비구역이 정확히 1개(method 'geocode_pip').
--   complex_zone = complex_map_anchor 좌표가 구역 폴리곤(단순화 전) 안(method 'pip'), 여러 개면 전부.

CREATE TABLE IF NOT EXISTS redev_zones (
  zone_id TEXT PRIMARY KEY,
  present_sn TEXT NOT NULL,
  name TEXT NOT NULL,
  category_code TEXT NOT NULL,
  category_name TEXT,
  lclas_cl TEXT,
  mlsfc_cl TEXT,
  sclas_cl TEXT,
  gu TEXT,
  gu_code TEXT,
  signgu_se TEXT,
  area_m2 REAL,
  notice_sn TEXT,
  notice_date TEXT,
  wtnnc_sn TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  rings TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redev_zones_lat_lng ON redev_zones (lat, lng);
CREATE INDEX IF NOT EXISTS idx_redev_zones_gu ON redev_zones (gu, category_code);

CREATE TABLE IF NOT EXISTS redev_projects (
  code TEXT PRIMARY KEY,
  gu TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  addr_jibun TEXT,
  addr_road TEXT,
  public_private TEXT,
  district_type TEXT,
  project_type TEXT,
  stage TEXT,
  households_before INTEGER,
  zone_designated_first TEXT,
  zone_designated_last TEXT,
  committee_approved TEXT,
  association_approved TEXT,
  building_review TEXT,
  project_approved_first TEXT,
  project_approved_last TEXT,
  disposal_approved_first TEXT,
  disposal_approved_last TEXT,
  relocation_start TEXT,
  relocation_end TEXT,
  construction_start TEXT,
  households_total INTEGER,
  households_sale INTEGER,
  households_rent INTEGER,
  base_date TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redev_projects_gu ON redev_projects (gu, stage);

CREATE TABLE IF NOT EXISTS redev_links (
  kind TEXT NOT NULL CHECK (kind IN ('project_zone', 'complex_zone')),
  ref_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  method TEXT NOT NULL,
  detail TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id, zone_id)
);
CREATE INDEX IF NOT EXISTS idx_redev_links_zone ON redev_links (zone_id, kind);
