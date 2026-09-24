-- DESIGN ONLY. Do not apply in this assignment-readiness run.
-- Preserves administrative reorganizations without duplicate school identities.

CREATE TABLE IF NOT EXISTS school_region_aliases (
  school_code TEXT NOT NULL,
  source_region_code TEXT NOT NULL,
  canonical_region_code TEXT NOT NULL,
  source_sido_name TEXT,
  canonical_sido_name TEXT,
  disclosure_year TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL,
  alias_reason TEXT NOT NULL CHECK (alias_reason IN (
    'HISTORICAL_REGION_CODE_ALIAS',
    'ADMIN_REORG_PREFIX_SWAP',
    'DISTRICT_SPLIT_RENUMBER'
  )),
  audited_at TEXT NOT NULL,
  PRIMARY KEY (school_code, source_region_code, disclosure_year, source)
);

-- DESIGN ONLY. KOIES 학교ID (B…) ↔ SchoolInfo SCHUL_CODE (S…).
-- Only EXACT_OFFICIAL_CODE and EXACT_MULTI_FIELD rows are candidate public-safe.

CREATE TABLE IF NOT EXISTS school_id_crosswalk (
  koies_school_id TEXT NOT NULL,
  school_code TEXT NOT NULL,
  school_level TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN (
    'EXACT_OFFICIAL_CODE',
    'EXACT_MULTI_FIELD',
    'HISTORICAL_ALIAS',
    'AMBIGUOUS',
    'NO_MATCH'
  )),
  evidence TEXT NOT NULL,
  source_version TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  PRIMARY KEY (koies_school_id, school_code, source_version)
);
