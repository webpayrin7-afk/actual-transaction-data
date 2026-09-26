-- 거래(transactions) 변경 표시 — 스냅샷 신선도 기준.
-- transactions 에 대한 모든 INSERT / UPDATE / DELETE 를 트리거가 잡는다
-- (sync-molit, full-history runner, scripts/fixes/* 의 직접 UPDATE 까지 — 쓰는 쪽 코드 수정 불필요).
--
-- tx_change_seq   : 전역 단조 증가 번호 1행. transactions 한 행이 바뀔 때마다 +1.
-- tx_change_marks : 단지(lawd_cd, apt_name_norm)마다 마지막으로 바뀐 전역 번호.
--                   시군구 번호 = MAX(seq) WHERE lawd_cd = ? (PK 앞부분 스캔),
--                   전역 번호 = tx_change_seq.seq.
-- 행을 지우지 않는다 — 번호는 줄지 않는다. 표시가 없는 단지 = 0 (트리거 설치 이후 한 번도 안 바뀜).
--
-- 쓰기 비용(Turso rows_written, 2026-09-26 Turso 복사 표로 측정): transactions 한 행 쓰기마다 +2
-- (tx_change_seq 1 + tx_change_marks 1). 단지 키(lawd_cd/apt_name_norm)가 바뀌는 UPDATE 는 +4.
-- 인덱스는 일부러 두지 않는다(인덱스 1개 = 행 쓰기마다 +1).
--
-- 새 테이블 2개 + transactions 트리거 4개. transactions 행·인덱스는 건드리지 않는다.
-- 스냅샷 규칙: src/lib/db/snapshot-freshness.ts

CREATE TABLE IF NOT EXISTS tx_change_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO tx_change_seq (id, seq) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS tx_change_marks (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  seq INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (lawd_cd, apt_name_norm)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_tx_change_ai
AFTER INSERT ON transactions
BEGIN
  INSERT INTO tx_change_seq (id, seq) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET seq = seq + 1;
  INSERT INTO tx_change_marks (lawd_cd, apt_name_norm, seq, changed_at)
    VALUES (NEW.lawd_cd, NEW.apt_name_norm,
            (SELECT seq FROM tx_change_seq WHERE id = 1),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (lawd_cd, apt_name_norm) DO UPDATE SET
      seq = excluded.seq, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_tx_change_au
AFTER UPDATE ON transactions
BEGIN
  INSERT INTO tx_change_seq (id, seq) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET seq = seq + 1;
  INSERT INTO tx_change_marks (lawd_cd, apt_name_norm, seq, changed_at)
    VALUES (NEW.lawd_cd, NEW.apt_name_norm,
            (SELECT seq FROM tx_change_seq WHERE id = 1),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (lawd_cd, apt_name_norm) DO UPDATE SET
      seq = excluded.seq, changed_at = excluded.changed_at;
END;

-- 단지 키가 바뀐 UPDATE: 옛 단지도 바뀐 것으로 표시
CREATE TRIGGER IF NOT EXISTS trg_tx_change_au_old
AFTER UPDATE OF lawd_cd, apt_name_norm ON transactions
WHEN OLD.lawd_cd IS NOT NEW.lawd_cd OR OLD.apt_name_norm IS NOT NEW.apt_name_norm
BEGIN
  INSERT INTO tx_change_seq (id, seq) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET seq = seq + 1;
  INSERT INTO tx_change_marks (lawd_cd, apt_name_norm, seq, changed_at)
    VALUES (OLD.lawd_cd, OLD.apt_name_norm,
            (SELECT seq FROM tx_change_seq WHERE id = 1),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (lawd_cd, apt_name_norm) DO UPDATE SET
      seq = excluded.seq, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_tx_change_ad
AFTER DELETE ON transactions
BEGIN
  INSERT INTO tx_change_seq (id, seq) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET seq = seq + 1;
  INSERT INTO tx_change_marks (lawd_cd, apt_name_norm, seq, changed_at)
    VALUES (OLD.lawd_cd, OLD.apt_name_norm,
            (SELECT seq FROM tx_change_seq WHERE id = 1),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (lawd_cd, apt_name_norm) DO UPDATE SET
      seq = excluded.seq, changed_at = excluded.changed_at;
END;
