-- 청약홈 사본: 무순위·잔여세대 공고 구분. NULL = 일반 APT 분양 공고(기존 행 그대로), 'remndr' = 무순위·잔여세대·취소후재공급.
-- scripts/applyhome/sync-applyhome.ts --apply 가 컬럼이 없을 때만 추가한다.
ALTER TABLE applyhome_notices ADD COLUMN notice_type TEXT;
