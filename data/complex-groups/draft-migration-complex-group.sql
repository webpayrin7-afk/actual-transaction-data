-- DRAFT — 적용하지 않음. 검토용. (src/lib/db/migrations 로 옮기기 전 owner 승인 필요)
-- 단지 묶음(complex group): 국토부 실거래 원자료가 지번별로 쪼갠 같은 단지("용산파크타워(24-0)", "(24-1)")를 한 부모로 잇는다.
-- 추가만 한다(additive). 기존 표·complex_id·transactions 는 그대로 둔다.

CREATE TABLE IF NOT EXISTS complex_group (
  group_id            TEXT PRIMARY KEY,                -- 'cg_' || primary_complex_id 뒤 16자 (결정적 → 재실행해도 같은 키)
  primary_complex_id  TEXT NOT NULL UNIQUE REFERENCES apt_complex_master(complex_id),
  display_name        TEXT NOT NULL,                   -- 괄호 지번 뗀 기본이름 ("용산파크타워")
  lawd_cd             TEXT NOT NULL,
  bjdong_cd           TEXT NOT NULL,
  anchor_lat          REAL,                            -- 멤버 동 외곽선 전체의 면적가중 중심 (없으면 대표 단지 앵커)
  anchor_lng          REAL,
  evidence_class      TEXT NOT NULL CHECK (evidence_class IN ('CONFIRMED', 'OWNER_APPROVED')),
  evidence_json       TEXT NOT NULL,                   -- 짝별 strong/weak 증거 원문 (dry-run JSON 그대로)
  rule_version        TEXT NOT NULL,                   -- 'complex-group-v1'
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complex_group_member (
  complex_id   TEXT PRIMARY KEY REFERENCES apt_complex_master(complex_id),  -- 한 단지는 한 묶음에만
  group_id     TEXT NOT NULL REFERENCES complex_group(group_id),
  role         TEXT NOT NULL CHECK (role IN ('PRIMARY', 'MEMBER')),
  lot_label    TEXT,                                   -- '24-1' (원자료 괄호 지번)
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cgm_group ON complex_group_member (group_id);
