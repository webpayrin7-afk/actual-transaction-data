/**
 * 걷는 사람 — 화면과 서버가 함께 쓰는 이름·모습 (속도로 시간을 계산하는 일은 서버 walk.ts에서만).
 *
 * 걸음 길이(한 걸음, m)와 걸음 수(걸음/초)는 걷는 사람 모형의 팔다리 흔들기에만 쓴다.
 * 근거는 walk.ts WALKER_MPS 주석과 같다 (성인 한 걸음 ≈ 키 × 0.41~0.43).
 */
export type WalkerId = "male" | "female" | "child" | "elder";

export const WALKER_IDS: WalkerId[] = ["male", "female", "child", "elder"];
export const DEFAULT_WALKER: WalkerId = "female";

export const WALKER_LABEL: Record<WalkerId, string> = {
  male: "성인 남성",
  female: "성인 여성",
  child: "어린이",
  elder: "어르신",
};

export type WalkerLook = {
  /** 키 (m) */
  heightM: number;
  /** 머리 크기 배율 — 어린이는 몸에 비해 머리가 크다 */
  head: number;
  /** 어깨·몸통 너비 배율 */
  build: number;
  /** 한 걸음 (m) */
  stepM: number;
  /** 걸음 수 (걸음/초) = 평지 속도 ÷ 한 걸음 */
  cadence: number;
  /** 앞으로 숙인 정도 (라디안) — 어르신은 조금 굽는다 */
  stoop: number;
  /** 팔다리 흔드는 폭 배율 */
  swing: number;
  shirt: number;
  pants: number;
};

export const WALKER_LOOK: Record<WalkerId, WalkerLook> = {
  // 1.35 m/s ÷ 0.75 m ≈ 1.8 걸음/초
  male: { heightM: 1.74, head: 1, build: 1.08, stepM: 0.75, cadence: 1.8, stoop: 0, swing: 1, shirt: 0x7cc7c0, pants: 0x6b7f9e },
  // 1.27 m/s ÷ 0.66 m ≈ 1.92 걸음/초
  female: { heightM: 1.61, head: 0.97, build: 0.94, stepM: 0.66, cadence: 1.92, stoop: 0, swing: 0.95, shirt: 0xf2b8c6, pants: 0x7d8fb3 },
  // 1.1 m/s ÷ 0.5 m ≈ 2.2 걸음/초
  child: { heightM: 1.3, head: 1.12, build: 0.82, stepM: 0.5, cadence: 2.2, stoop: 0, swing: 1.1, shirt: 0xf6d38a, pants: 0x8cb8e0 },
  // 1.0 m/s ÷ 0.58 m ≈ 1.72 걸음/초 — 폭은 작게, 몸은 조금 숙여
  elder: { heightM: 1.6, head: 0.98, build: 0.98, stepM: 0.58, cadence: 1.72, stoop: 0.14, swing: 0.6, shirt: 0xb8a6d9, pants: 0x8a8f99 },
};

export const isWalkerId = (v: unknown): v is WalkerId => typeof v === "string" && (WALKER_IDS as string[]).includes(v);
