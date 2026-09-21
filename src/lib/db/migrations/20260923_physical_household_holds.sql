-- Physical household totals from compact exact-dong unit evidence.
-- Does not alter title household_count, Core unit types, or public exact links.
-- Unresolved holds are internal accounting only.

CREATE TABLE IF NOT EXISTS building_unit_unresolved_holds (
  complex_id TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  household_count INTEGER NOT NULL,
  source_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, resolution_status),
  CHECK (resolution_status IN (
    'GROUP_ONLY',
    'NO_CANONICAL_TYPE',
    'NO_BUILDING_IDENTITY',
    'NO_DONG',
    'NO_DONG_MATCH',
    'NO_KEYMAP_COMPLEX',
    'PNU_CONFLICT'
  ))
);
