-- 지역 페이지 "새로 확인된 거래"(/api/region-daily part=latest·history·days, 이번 달) 첫 화면 스냅샷.
-- 동기화 뒤 scripts/build-region-daily-snapshot.ts 가 바뀐 지역만 채운다 (규칙: src/lib/region/region-daily-snapshot.ts).
-- 지역·part·월 한 행 (날짜는 열) — 날짜가 바뀌어도 DELETE 없이 같은 행을 고쳐 쓴다. 지난 달 행은 빌더가 지운다.
--
-- tx_mark      : 계산 전에 읽은 그 지역 시군구들 거래 변경 번호 (tx_change_marks MAX(seq)). 읽기는 지금 번호와 같을 때만.
-- build_seq    : 계산 전 전역 번호 (tx_change_seq) — 빌더가 "그 뒤로 아무것도 안 바뀜"을 싸게 알아보는 용도.
-- months_key   : 계산 전 sync_months 달 목록 (쉼표로 이음, 없으면 '').
-- hero_date / hero_is_today : 결과의 selectedDate / latestIsToday — 날짜가 바뀐 뒤에도 같은 결과인지 판단.
-- source_sync  : 옛 열 (쓰지 않음, '').
--
-- 이미 있는 표(옛 열만 있음)는 빌더가 ALTER TABLE ADD COLUMN 으로 새 열만 더한다 (--apply 때).

CREATE TABLE IF NOT EXISTS region_daily_snapshot (
  region_slug TEXT NOT NULL,
  part TEXT NOT NULL,
  year_month TEXT NOT NULL,
  seoul_date TEXT NOT NULL,
  source_sync TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  tx_mark INTEGER,
  build_seq INTEGER,
  months_key TEXT,
  hero_date TEXT,
  hero_is_today INTEGER,
  PRIMARY KEY (region_slug, part, year_month)
);
