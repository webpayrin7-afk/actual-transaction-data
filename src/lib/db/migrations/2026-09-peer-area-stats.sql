-- Additive: 단지 비교 후보(complex-compare-peers)용 매매 면적·준공연도 집계 스냅샷.
-- 새 테이블만 만든다. transactions 인덱스·컬럼은 건드리지 않는다.
-- refreshPeerAreaStats(src/lib/complex-detail/peer-area-stats-refresh.ts)가 IF NOT EXISTS 로 만든다.
--
-- 한 행 = (법정동코드, 단지명 정규화, 구) 하나. stats_json 은
--   [[exclusive_area, build_year, c], ...]  (매매, exclusive_area > 0, gu 가 비어 있지 않은 행)
-- 라이브 쿼리(select-compare-peers 2단계)의
--   GROUP BY apt_name_norm, exclusive_area, build_year  ... COUNT(*) AS c
-- 와 같은 집계를 lawd_cd 단위로 나눠 둔 것. 읽을 때 lawd_cd 여러 개를 (면적, 준공연도)로 합친다.
-- content_hash = sha1(stats_json) — 갱신 때 바뀐 행만 UPSERT 한다.
CREATE TABLE IF NOT EXISTS apt_trade_area_stats (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  gu TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (lawd_cd, apt_name_norm, gu)
);

-- 법정동코드별 게시 번호 (거래 변경 표시 tx_change_marks 기준, src/lib/db/snapshot-freshness.ts).
-- seq      : 이 코드의 스냅샷 행이 이 번호 시점 거래와 같다(게시). 갱신 중·게시 실패면 NULL.
--            읽는 쪽은 seq = 현재 코드 번호(MAX(tx_change_marks.seq))일 때만 스냅샷을 쓴다.
-- base_seq : 마지막으로 다 맞춘 번호 — 다음 갱신은 이 뒤에 바뀐 단지만 다시 집계한다.
CREATE TABLE IF NOT EXISTS apt_trade_area_stats_marks (
  lawd_cd TEXT PRIMARY KEY,
  seq INTEGER,
  base_seq INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
