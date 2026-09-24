-- 청약홈(한국부동산원) 분양정보 사본 — 공공데이터포털 odcloud API.
-- New tables only. 원천을 그대로 옮긴 사본이라 원천이 바뀌면 같은 키 행을 갱신한다(payload_hash로 변경 감지).
-- lawd_cd: 공급위치 주소의 시·도 + 시·군·구(+구) 이름이 법정 시군구 이름과 정확히 같을 때만. 애매하면 NULL.

CREATE TABLE IF NOT EXISTS applyhome_notices (
  house_manage_no TEXT PRIMARY KEY,
  pblanc_no TEXT,
  house_nm TEXT NOT NULL,
  house_secd_nm TEXT,
  house_dtl_secd_nm TEXT,
  rent_secd_nm TEXT,
  area_name TEXT,
  address TEXT,
  lawd_cd TEXT,
  total_supply INTEGER,
  notice_date TEXT,
  special_rcept_begin TEXT,
  rcept_begin TEXT,
  rcept_end TEXT,
  winner_date TEXT,
  contract_begin TEXT,
  contract_end TEXT,
  move_in_ym TEXT,
  builder TEXT,
  developer TEXT,
  homepage TEXT,
  notice_url TEXT,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applyhome_notices_rcept ON applyhome_notices (rcept_begin);
CREATE INDEX IF NOT EXISTS idx_applyhome_notices_lawd_movein ON applyhome_notices (lawd_cd, move_in_ym);

CREATE TABLE IF NOT EXISTS applyhome_models (
  house_manage_no TEXT NOT NULL,
  model_no TEXT NOT NULL,
  house_ty TEXT,
  supply_area REAL,
  general_supply INTEGER,
  special_supply INTEGER,
  top_amount INTEGER,
  payload_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (house_manage_no, model_no)
);

CREATE TABLE IF NOT EXISTS applyhome_competition (
  house_manage_no TEXT NOT NULL,
  model_no TEXT NOT NULL,
  rank_code INTEGER NOT NULL,
  reside_code TEXT NOT NULL,
  house_ty TEXT,
  reside_name TEXT,
  supply_count INTEGER,
  request_count INTEGER,
  competition_rate TEXT,
  payload_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (house_manage_no, model_no, rank_code, reside_code)
);
