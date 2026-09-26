-- 단지 실거래 원본 스냅샷 v2 (apt_tx_hist_snap). 새 표 1개 — transactions 에는 인덱스·컬럼·트리거 추가 없음.
-- 전제: 20261001_tx_change_marks.sql (transactions 변경 표시 트리거) 적용.
--
-- 단지(lawd_cd, apt_name_norm)마다 queryAptTransactions 라이브 쿼리(전체 이력, trade+rent)와 같은 행 집합
-- (같은 컬럼 매핑, ORDER BY deal_date DESC, id)을 컬럼형 JSON(format 2) → brotli 한 BLOB 1행.
-- mark = 빌드 직전에 읽은 tx_change_marks 단지 번호. 요청 경로는 같은 SELECT 에서 현재 번호를 읽어
--        같을 때만 스냅샷을 쓰고, 다르면(행 수가 그대로인 직접 UPDATE 포함) 라이브 쿼리.
-- 작은 컬럼을 payload(BLOB) 앞에 둬서 메타만 읽을 때 overflow 페이지를 타지 않게 함.
-- 조회는 PK 등치 검색만.
--
-- 기존 apt_tx_snapshot(format 1, gzip, sync_months watermark 기준)은 더 이상 읽지 않는다.
-- 새 표 적재가 끝나면 지워도 된다(소유자 판단): DROP TABLE apt_tx_snapshot;
--   DELETE FROM snapshot_watermark WHERE family > 'apt_tx:' AND family < 'apt_tx;';
--
-- 적재·갱신: scripts/build-apt-tx-snapshot.ts (초기 --all --apply),
--           scripts/sync-molit.ts 끝 refreshAptTxSnapshots (snapshot_watermark family='apt_tx_hist' = 반영한 tx_change_seq).

CREATE TABLE IF NOT EXISTS apt_tx_hist_snap (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  mark INTEGER NOT NULL,
  format INTEGER NOT NULL,
  tx_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (lawd_cd, apt_name_norm)
);

-- 이미 Production 에 이 모양으로 있음 (다른 스냅샷 계열과 같이 씀)
CREATE TABLE IF NOT EXISTS snapshot_watermark (
  family TEXT PRIMARY KEY,
  synced_through TEXT NOT NULL,
  built_at TEXT NOT NULL
);
