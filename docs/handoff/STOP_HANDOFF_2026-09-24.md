# ZIPLAB 적재 중지 인수인계 (2026-09-24 16:35 UTC)

작성: Cursor 데이터 감시 에이전트 · 오너 중지 요청에 따라 **모든 적재·타이머·감시 루프 정지 완료**. 새 배치 시작 안 함. Claude 세션이 이어서 재개.

---

## 0. 정지 상태 (검증)

| 항목 | 상태 |
|---|---|
| molit full-history runner | **STOPPED** (PID TERM/KILL, `run.lock` 제거) |
| mgmt-fee provinces driver + daegu acquire | **STOPPED** (tmux `fee-provinces` 종료) |
| vworld-watch | **STOPPED** |
| data-pipeline-watch timer | **UNSUBSCRIBED** |
| 새 배치 | 시작하지 않음 |

런타임 산출물(체크포인트)은 디스크에 보존. DB 롤백 없음.

---

## 1. 매매·전월세 전국 full-history (molit)

| | |
|---|---|
| **작업명** | 전국 매매·전월세 missing-only full-history 백필 |
| **브랜치 / PR** | `cursor/tx-registration-status-1922` / [#131](https://github.com/webpayrin7-afk/actual-transaction-data/pull/131) |
| **워크트리** | `/home/ubuntu/wt/tx` (현재 detached HEAD — 런타임 산출물은 gitignore) |
| **스크립트** | `scripts/full-history/runner.mts`, `scripts/full-history/start.sh` |
| **재개 명령** | `cd /home/ubuntu/wt/tx && bash scripts/full-history/start.sh` |
| **대상 테이블** | Production Turso `transactions` (SALE/RENT 셀 missing-only insert) |

### 완료 범위 (중지 시점 2026-09-24T16:34:51Z)

| 지표 | 값 |
|---|---|
| `progress.completedCount` | **20,309** |
| `progress.failedCount` | **103** |
| `progress.inserted` | **3,586,148** |
| `progress.updated` | 216,376 |
| saleCells / rentCells | 11,589 / 8,720 |
| 현재 위치 | **incheon SALE 201903** (priority 3) |
| heartbeat cursor | 14,858 · pending(하트비트) 18,689 |
| API 호출(누적 `apiCalls`) | **20,530** |

매니페스트 요약(`data/poc/full-history/manifest-summary.json`): SALE expected 30,480 / RENT expected 12,192 · requestLawds 254.

### 마지막 체크포인트 (파일)

모두 `/home/ubuntu/wt/tx/data/poc/full-history/` (gitignore — 커밋 안 됨, 디스크 유지):

- `progress.json` — 진행 수치
- `heartbeat.json` — 마지막 셀 위치 (`at=2026-09-24T16:34:51.959Z`)
- `checkpoint.json` — 러너 체크포인트
- `retry-queue.jsonl` — 121 lines
- `runner.log` — 실행 로그
- `run.lock` — **삭제됨** (재개 시 start.sh가 새로 생성)

### 남은 범위

- incheon SALE 201903 이후 ~ 전국 remaining SALE/RENT missing cells
- priority 3 큐 계속 → 이후 priority 큐 소진까지
- fail=103 셀은 retry-queue / 로그에 기록됨 (timeout·fetch failed 등). 재개 시 러너 정책대로 스킵/재시도

### 실패·보류 요약

- 최근 FAIL 예: `trade|48330|202203`, `trade|48310|202203` (`fetch failed`); timeout 다수(경남 등)
- `trueNodataLawds`: `28720` (매니페스트)
- 간헐 fetch fail 시 heartbeat가 수 분 멈출 수 있으나 wchar가 움직이면 stall 아님. **stall 재시작 규칙**: hb age>12min **AND** low wchar → PID-only kill (pkill -f 금지) 후 start.sh

### 외부 API

- **MOLIT/data.go.kr** 아파트 매매·전월세 실거래 API
- 오늘(러너 누적 기준) 호출량: progress `apiCalls` **≈20,530** (세션 전체 누적; 일자별 키 쿼터와 별개로 러너 카운터)

### 주의점

- `--daemon --apply=1 --concurrency=2 --sleep-ms=250 --first-batch=8`
- Production 쓰기 missing-only. 추정·퍼지 조인 금지
- 워크트리 detached면 재개 전 `cursor/tx-registration-status-1922` 체크아웃 권장

---

## 2. 관리비 시·도 확장 (mgmt-fee provinces)

| | |
|---|---|
| **작업명** | 관리비 canonical 시·도 순차 acquire → dry-run → apply → verify |
| **브랜치 / PR** | `cursor/mgmt-fee-provinces-6779` / [#136](https://github.com/webpayrin7-afk/actual-transaction-data/pull/136) |
| **워크트리** | `/home/ubuntu/wt/fee` |
| **스크립트** | `scripts/mgmt-fee-canonical/start-provinces.sh`, `run-province-final.mts`, `apply-province-final.mts` |
| **재개 명령** | `cd /home/ubuntu/wt/fee && bash scripts/mgmt-fee-canonical/start-provinces.sh` (이미 APPLIED인 인천·부산은 스킵, 대구는 체크포인트 resume) |
| **대상 테이블** | Production 관리비 fee canonical 테이블 (단지×월). 중지 시점 fee_table **4,819 rows / 4,706 complexes** |

### 시도별 완료

| province | phase | cohort | terminal | COMPLETE | NO_PUB | applied_rows | api_calls |
|---|---|---|---|---|---|---|---|
| incheon | **APPLIED** | 1093 | 1093 | 1015 | 78 | **1015** | 30684 |
| busan | **APPLIED** | 993 | 993 | 881 | 112 | **881** | 26766 |
| **daegu** | **ACQUIRING (중지)** | 1151 | **393** (seg-state) | **371** | **22** | 0 | **11,240** |
| gwangju-jeonnam … jeju | PENDING | — | — | — | — | 0 | 0 |

- `applied_rows_total` = **1,896** (인천+부산만 DB 반영)
- 대구는 dry-run/apply **미실시**. acquire만 진행 중 중지
- 세그먼트: `segments_completed=9`, segment_size=40. 세그먼트 10 진행 중 오너 중지로 TERM (중간 롤백 없음; 체크포인트에 COMPLETE 371건까지 보존)
- `PROVINCE_SEGMENT_PAUSE` 후 드라이버가 자동 resume하는 구조 — 재개 시 start-provinces.sh가 daegu 체크포인트부터 이어감

### 마지막 체크포인트 (파일)

`/home/ubuntu/wt/fee/data/poc/mgmt-fee-canonical/`:

- `province-daegu-final-op-checkpoint.json`
- `province-daegu-final-segment-state.json` (updated `2026-09-24T16:34:45.548Z`)
- `province-daegu-final-cohort.json` (+ `.sha256`)
- `province-daegu-final-identity-guard.json`
- `provinces-progress.json` (중지 스냅샷으로 갱신: `driver_status=STOPPED…`)
- 인천/부산: `province-*-final-apply-result.json` status PASS · verify IDEMPOTENT_NOOP 완료

### 남은 범위

1. 대구 acquire 완료 → dry-run PASS → apply → verify no-op
2. 이후 순서: `gwangju-jeonnam daejeon ulsan sejong gangwon chungbuk chungnam jeonbuk gyeongbuk gyeongnam jeju`

### 실패·보류

- 대구: FAILED/PARTIAL/IDENTITY_CONFLICT = 0 (현재 분류분)
- timeouts 누적 13 · retries 13 · http_429=0 · http_5xx=0 (세그먼트 상태)
- 간헐 timeout으로 api 진행이 수 분 평탄해질 수 있음 — 15분 이상 무진행만 조사

### 외부 API

- **KAPT / data.go.kr** 관리비·단지 공시 API (province final live calls)
- 누적 `api_calls_total`(progress 합산 기준) **≈66,591** (인천 30,684 + 부산 26,766 + 대구 11,240). 키 값 기재 안 함
- 일일 쿼터 소진 시 드라이버가 다음날 00:10 KST까지 hold (`rc=2`)

### 주의점

- dry-run → 건수 확인 → apply → 재실행 0건(IDEMPOTENT_NOOP)
- missing-only / 이미 APPLIED province는 스킵
- UI 브랜치(`cursor/ziplab-ui-policy-v2-6779`) 금지

---

## 3. VWorld 감시

| | |
|---|---|
| **작업명** | VWorld AL_D002 / join 가용성 감시 |
| **브랜치 / PR** | `cursor/vworld-watch-6779` / [#135](https://github.com/webpayrin7-afk/actual-transaction-data/pull/135) |
| **스크립트** | `scripts/living/vworld-watch.sh` |
| **재개** | `cd /home/ubuntu/wt/living && bash scripts/living/vworld-watch.sh` |
| **상태** | 장기간 **WAIT_VWORLD** (502 / RemoteDisconnected). 마지막 로그 `2026-09-24T16:18:16Z` |
| **로그** | `data/cache/vworld-join/watch.log` |

US AWS에서 AL_D002 접근 불안정 — 오너 PC/국내망 잔여 좌표 추출과 별개.

---

## 4. 이미 완료·참고 (이 세션 범위 밖 유지)

- 전월세 서울 25구 과거 백필 · 전세가율 rematerialize — 완료 (현황판 참고)
- 좌표 잔여→생활→학교 배치 — 완료(이번 배치). 잔여 exact-PNU ~3,612는 오너 PC
- 현황판: `docs/handoff/ZIPLAB_STATUS.md` (living)

---

## 5. 재개 체크리스트 (Claude)

1. `docs/handoff/ZIPLAB_STATUS.md` + **이 파일** 확인
2. 프로세스/타이머 없음 확인 후 필요 파이프라인만 start
3. 대구: `start-provinces.sh` → acquire resume → dry-run → apply → verify
4. molit: `wt/tx`에서 브랜치 정렬 후 `bash scripts/full-history/start.sh`
5. Production 배포 금지 · 비밀키 출력 금지 · Composer/데이터 vs UI(Claude Max) 역할 분담 유지
