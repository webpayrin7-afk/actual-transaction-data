-- DESIGN ONLY. Do not apply this file to production in the incremental run.
-- Official KOIES / data.go.kr polygons use 학교ID (for example B000002433),
-- not SchoolInfo SCHUL_CODE. Middle and high areas are groups, not an exact
-- assigned school. Nationwide linkage is not verified.

CREATE TABLE IF NOT EXISTS school_assignment_areas (
  assignment_area_id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('elementary', 'middle', 'high')),
  region TEXT,
  official_name TEXT NOT NULL,
  geometry_ref TEXT,
  valid_from TEXT,
  valid_to TEXT,
  source TEXT NOT NULL,
  source_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS school_assignment_area_members (
  assignment_area_id TEXT NOT NULL,
  school_code TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN (
    'ELEMENTARY_ATTENDANCE',
    'MIDDLE_SCHOOL_GROUP',
    'EXACT_ASSIGNED_SCHOOL',
    'HIGH_SCHOOL_GROUP',
    'HIGH_ALLOCATION_CATEGORY'
  )),
  PRIMARY KEY (assignment_area_id, school_code, membership_type)
);

CREATE TABLE IF NOT EXISTS complex_assignment_area_links (
  complex_id TEXT NOT NULL,
  assignment_area_id TEXT NOT NULL,
  match_method TEXT NOT NULL,
  source_version TEXT NOT NULL,
  PRIMARY KEY (complex_id, assignment_area_id)
);
