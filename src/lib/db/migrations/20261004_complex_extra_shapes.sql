-- 3D 단지 동 모양 채우기 — 건축물대장(complex_buildings)에 행이 없는 단지 건물의 외곽선. New table only (더하기만).
-- 예: 한강맨숀처럼 동마다 필지가 달라 표제부가 대표 필지 1행뿐인 단지의 나머지 동, 대장 1행 ↔ SPBD A·B동.
-- 후보는 엄격 규칙(data/building-coverage/PLAN.md C절)만 — scripts/building-coverage/apply-fill.mts가 넣는다.
-- source: 'GIS'(gis_buildings AL_D010 행) | 'SPBD'(브이월드 도로명주소 건물, gis_buildings에도 bldrgst_pk NULL로 있음).
-- read.ts는 이 행들을 단지 동(id 'x:'+bld_key)으로 덧붙인다. 한 도형은 한 단지에만 (bld_key UNIQUE).
CREATE TABLE IF NOT EXISTS complex_extra_shapes (
  complex_id TEXT NOT NULL,
  bld_key TEXT NOT NULL,
  source TEXT NOT NULL,
  rule TEXT NOT NULL,
  dong_label TEXT,
  name TEXT,
  residential INTEGER NOT NULL DEFAULT 1,
  floors_above INTEGER,
  height_m REAL,
  approval_date TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  rings TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, bld_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_complex_extra_shapes_bld ON complex_extra_shapes (bld_key);
