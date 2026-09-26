-- 건축물대장 전유공용면적 → 동·호 라인별 평형. 이 테이블만 추가한다.
-- line: 호 번호의 끝 두 자리 (1302호 → 02). exclusive_area 는 전용(㎡, 소수 2자리).
-- supply_area = 전용 + 주거공용. 기타공용은 넣지 않는다.
-- 같은 동·라인·전용면적의 호 수가 unit_count.
CREATE TABLE IF NOT EXISTS complex_unit_lines (
  building_id TEXT NOT NULL,
  complex_id TEXT NOT NULL,
  line TEXT NOT NULL,
  exclusive_area REAL NOT NULL,
  supply_area REAL NOT NULL,
  unit_count INTEGER NOT NULL,
  floor_min INTEGER,
  floor_max INTEGER,
  source_as_of TEXT NOT NULL,
  PRIMARY KEY (building_id, line, exclusive_area)
);
CREATE INDEX IF NOT EXISTS idx_complex_unit_lines_complex ON complex_unit_lines (complex_id);
