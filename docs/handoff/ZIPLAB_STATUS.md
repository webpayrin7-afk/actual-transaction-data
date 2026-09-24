# ZIPLAB 인수인계 현황판

기준 시각: 2026-09-24 16:35 UTC · **적재 중지 완료** · 상세: [`STOP_HANDOFF_2026-09-24.md`](./STOP_HANDOFF_2026-09-24.md) · living `cursor/vworld-watch-6779`

이 문서는 Claude Max(Opus)와 Cursor(Composer)가 같은 현황을 보고 이어서 작업하기 위한 한 장짜리 현황판이다. 작업을 넘겨받으면 이 문서부터 읽고, 상태가 바뀌면 이 문서를 갱신한다.

## 0. 역할 분담 (오너 결정 2026-09-23)

| 영역 | 담당 |
|---|---|
| 주요 기능 구상·구현, UI/UX 판단 | Claude Max (Opus) |
| 데이터 적재·백필·반복 배치 | Cursor 클라우드 에이전트, **Composer 2.5 모델만** (Opus 금지) — **오너 요청으로 2026-09-24 16:35Z 중지. 이후 적재는 Claude 세션이 이어받음** |

공통 규칙
- Production 배포 금지(오너 별도 지시 전까지). PR은 draft로 올리고 병합은 오너가 한다.
- 비밀값(키, 토큰) 출력 금지. DB는 Turso(libsql) Production 하나다 — 쓰기 작업은 dry-run → 건수 확인 → 적용 → 재실행 0건 확인.
- 데이터 쓰기는 "비어 있는 것만 채우기(missing-only / NULL-only)"가 기본. 추정값·퍼지 조인 금지.
- 화면 작업은 `docs/design/ziplab-ui-policy-v2.md` 12장이 기준.
- Next.js 16: `AGENTS.md` 안내대로 `node_modules/next/dist/docs/` 확인 후 작성.

## 1. 화면(UI) — PR [#127](https://github.com/webpayrin7-afk/actual-transaction-data/pull/127)

브랜치 `cursor/ziplab-ui-policy-v2-6779` → base `cursor/advancement-ratio-viz-b2d5` (draft). Claude Max 담당.

## 2. 데이터 적재 현황 — **전부 STOPPED (16:35Z)**

상세 재개 정보: **`docs/handoff/STOP_HANDOFF_2026-09-24.md`**

| 작업 | 브랜치 / PR | 중지 시점 상태 | 재개 |
|---|---|---|---|
| 전월세 서울 과거 · 전세가율 rematerialize | living | **완료** (이전) | — |
| 매매·전월세 전국 full-history | #131 | **STOPPED** completedCount **20,309** · fail=103 · ins=3,586,148 · incheon SALE 201903 · lock 제거 | `cd /home/ubuntu/wt/tx && bash scripts/full-history/start.sh` |
| 관리비 시·도 | #136 | 인천·부산 **APPLIED** (+1896). 대구 **ACQUIRING 중지** terminal **393**/1151 · api=11,240 · seg=9 · DB 미적용 | `cd /home/ubuntu/wt/fee && bash scripts/mgmt-fee-canonical/start-provinces.sh` |
| 좌표·생활·학교 배치 | #135 / #134 | **완료(이전 배치)** | 잔여 exact-PNU 오너 PC |
| VWorld 감시 | #135 | **STOPPED** (마지막 WAIT 16:18Z) | `bash scripts/living/vworld-watch.sh` |

타이머 `data-pipeline-watch` · tmux molit/fee/vworld 적재 프로세스 — 모두 종료.

## 3. 오너 결정 대기

1. 좌표 잔여 ~3,612(exact-PNU) — 오너 PC
2. 관리비 대구 acquire 재개 → dry-run → apply (Claude)
3. PR #101, #120 닫기(UI #127로 대체)

## 4. 참고 경로

- **중지 인수인계**: `docs/handoff/STOP_HANDOFF_2026-09-24.md`
- UI 정책: `docs/design/ziplab-ui-policy-v2.md`
- 오너 PC 지적도: `scripts/living/local-extract-residual-parcels.py`
