-- K-apt 기본정보 codeHallNm (현관구조). NULL until an official value is stored.
-- Allowed values written by scripts/profile-fill: '계단식' | '복도식' | '혼합식'.
-- Safe to re-run: the fill script adds the column only when PRAGMA table_info lacks it.

ALTER TABLE apt_complex_profile ADD COLUMN corridor_type TEXT;
