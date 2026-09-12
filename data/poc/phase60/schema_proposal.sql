-- Phase 6.0 proposal ONLY — do not execute against production.
-- Apartment Master v1 minimal schema.

-- Opaque immutable complex identity.
CREATE TABLE IF NOT EXISTS apt_complex_master (
  complex_id TEXT PRIMARY KEY,
  apt_name TEXT NOT NULL DEFAULT '',
  apt_name_norm TEXT NOT NULL,
  sido TEXT NOT NULL DEFAULT '',
  sido_code TEXT NOT NULL DEFAULT '',
  sigungu TEXT NOT NULL DEFAULT '',
  lawd_cd TEXT NOT NULL,
  legal_dong_name TEXT NOT NULL DEFAULT '',
  bjdong_cd TEXT NOT NULL DEFAULT '',
  jibun TEXT NOT NULL DEFAULT '',
  road_address TEXT,
  latitude REAL,
  longitude REAL,
  identity_status TEXT NOT NULL
    CHECK (identity_status IN (
      'IDENTITY-READY',
      'IDENTITY-AMBIGUOUS',
      'IDENTITY-UNRESOLVED'
    )),
  identity_reason_codes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acm_lawd_norm
  ON apt_complex_master (lawd_cd, apt_name_norm);
CREATE INDEX IF NOT EXISTS idx_acm_parcel
  ON apt_complex_master (lawd_cd, bjdong_cd, jibun);
CREATE INDEX IF NOT EXISTS idx_acm_status
  ON apt_complex_master (identity_status);

-- External / source-specific identifiers → complex_id.
CREATE TABLE IF NOT EXISTS apt_complex_source_links (
  complex_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_meta_json TEXT NOT NULL DEFAULT '{}',
  source_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_key)
);

CREATE INDEX IF NOT EXISTS idx_acsl_complex
  ON apt_complex_source_links (complex_id);

-- Generic enrichment state (one row per complex × domain). Prefer lazy insert.
CREATE TABLE IF NOT EXISTS apt_complex_enrichment_state (
  complex_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'READY',
      'PENDING',
      'UNRESOLVED',
      'FAILED',
      'NOT_REQUIRED',
      'STALE'
    )),
  reason_code TEXT NOT NULL DEFAULT '',
  data_version INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_aces_domain_status
  ON apt_complex_enrichment_state (domain, status, data_version);
