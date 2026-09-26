/**
 * 스냅샷 신선도 — transactions 변경 표시(tx_change_marks / tx_change_seq) 기준.
 *
 * 변경 표시는 transactions 트리거가 채운다(src/lib/db/migrations/20261001_tx_change_marks.sql).
 * sync_months.synced_at·행 수가 아니라 "transactions 행이 실제로 바뀌었는가"를 본다 —
 * sync 밖의 직접 UPDATE(scripts/fixes/*, full-history runner)와 sync 도중(묶음 일부만 들어간 상태)도 잡힌다.
 *
 * 번호(mark) 규칙
 * - 전역 번호 tx_change_seq.seq 는 transactions 한 행이 바뀔 때마다 +1 (줄지 않음).
 * - 단지 번호 = 그 단지가 마지막으로 바뀐 때의 전역 번호. 표시 없음 = 0.
 * - 여러 단지·시군구 묶음 번호 = 그 안의 MAX. 묶음 안 어느 행이든 바뀌면 커진다.
 *
 * 쓰는 쪽(스냅샷 빌더)
 * 1) 계산 전에 readChangeMark(scope) → mark
 * 2) transactions 읽어 계산
 * 3) 저장은 markUnchangedCondition(scope, mark) 를 WHERE 로 건 조건부 쓰기
 *    (INSERT ... SELECT ... WHERE <조건>) — 계산 도중 바뀌었으면 저장되지 않는다.
 *    조건부 쓰기가 어려우면 computeWithFreshnessGuard 로 계산 뒤 한 번 더 확인.
 * 4) 스냅샷 행에 mark 를 같이 저장.
 * 읽기 실패·부분 결과는 스냅샷으로 저장하지 않는다 — 에러는 그대로 던진다.
 *
 * 읽는 쪽
 * - 스냅샷 SELECT 에 changeMarkSubquery(scope) 를 컬럼으로 붙여 1왕복으로 현재 번호를 같이 읽고,
 *   저장된 mark 와 같을 때만 스냅샷을 쓴다. 다르거나, 읽기 에러(표 없음 포함)면 라이브 쿼리.
 *
 * 규칙: transactions 에 쓰는 코드는 트리거가 알아서 표시한다. 단,
 * INSERT OR REPLACE 로 다른 단지의 행을 덮어쓰면 옛 단지가 표시되지 않으므로 쓰지 않는다
 * (지우고 넣거나 UPDATE 사용). 트리거를 지우거나 끄지 않는다.
 */
import type { Client, InStatement } from "@libsql/client";

export type ComplexKey = { lawdCd: string; aptNameNorm: string };

/**
 * 신선도를 볼 범위.
 * - global: transactions 전체 (전국 스냅샷)
 * - lawds: 시군구들 (지역 스냅샷)
 * - complexes: 단지들 (단지 스냅샷)
 * lawds 와 complexes 를 같이 주면 둘 다 본다(MAX).
 */
export type ChangeScope =
  | { global: true }
  | { global?: false; lawds?: readonly string[]; complexes?: readonly ComplexKey[] };

type SqlPart = { sql: string; args: Array<string | number> };

function isGlobal(scope: ChangeScope): scope is { global: true } {
  return (scope as { global?: boolean }).global === true;
}

/**
 * 현재 번호를 돌려주는 스칼라 서브쿼리 (괄호 포함). 결과는 항상 정수(없으면 0).
 * 스냅샷 SELECT 에 컬럼으로 붙이거나 조건부 쓰기 WHERE 에 쓴다.
 */
export function changeMarkSubquery(scope: ChangeScope): SqlPart {
  if (isGlobal(scope)) {
    return {
      sql: `(SELECT COALESCE((SELECT seq FROM tx_change_seq WHERE id = 1), 0))`,
      args: [],
    };
  }
  const lawds = [...new Set(scope.lawds ?? [])];
  const complexes = scope.complexes ?? [];
  if (lawds.length === 0 && complexes.length === 0) {
    throw new Error("changeMarkSubquery: empty scope");
  }
  const parts: string[] = [];
  const args: Array<string | number> = [];
  if (lawds.length > 0) {
    parts.push(
      `SELECT MAX(seq) AS s FROM tx_change_marks WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    );
    args.push(...lawds);
  }
  if (complexes.length > 0) {
    const seen = new Set<string>();
    const pairs: ComplexKey[] = [];
    for (const c of complexes) {
      const k = `${c.lawdCd}\u0000${c.aptNameNorm}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push(c);
    }
    parts.push(
      `SELECT MAX(seq) AS s FROM tx_change_marks WHERE ${pairs
        .map(() => "(lawd_cd = ? AND apt_name_norm = ?)")
        .join(" OR ")}`,
    );
    for (const p of pairs) args.push(p.lawdCd, p.aptNameNorm);
  }
  return {
    sql: `(SELECT COALESCE(MAX(s), 0) FROM (${parts.join(" UNION ALL ")}))`,
    args,
  };
}

function toMark(value: unknown): number {
  // null·빈 문자열이 0 으로 바뀌지 않게 숫자/bigint/숫자 문자열만 받는다
  const n =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`tx change mark: unexpected value ${String(value)}`);
  }
  return n;
}

/** 현재 번호. 에러(표 없음 포함)는 그대로 던진다 — 쓰는 쪽은 저장을 멈춰야 한다. */
export async function readChangeMark(db: Client, scope: ChangeScope): Promise<number> {
  const sub = changeMarkSubquery(scope);
  const rs = await db.execute({ sql: `SELECT ${sub.sql} AS mark`, args: sub.args });
  return toMark(rs.rows[0]?.mark);
}

/**
 * 조건부 쓰기용 WHERE 조건: 현재 번호가 아직 mark 와 같을 때만 참.
 * 예) INSERT INTO snap (k, payload, mark) SELECT ?, ?, ? WHERE <sql>  (args 이어 붙이기)
 */
export function markUnchangedCondition(scope: ChangeScope, mark: number): SqlPart {
  const sub = changeMarkSubquery(scope);
  return { sql: `${sub.sql} = ?`, args: [...sub.args, toMark(mark)] };
}

/**
 * 읽는 쪽: 저장된 mark 가 지금도 최신인가. 표 없음·에러·잘못된 값이면 false(라이브로).
 * 가능하면 스냅샷 SELECT 에 changeMarkSubquery 를 붙여 1왕복으로 비교한다 — 이 함수는 왕복 1회 추가.
 */
export async function isSnapshotFresh(
  db: Client,
  scope: ChangeScope,
  storedMark: unknown,
): Promise<boolean> {
  let stored: number;
  try {
    stored = toMark(storedMark);
  } catch {
    return false;
  }
  try {
    return (await readChangeMark(db, scope)) === stored;
  } catch (err) {
    console.warn(
      "[snapshot-freshness] mark read failed — live fallback:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** 스냅샷 행에서 읽은 저장 mark 와 같은 SELECT 에서 읽은 현재 mark 비교 (값이 이상하면 false). */
export function isMarkCurrent(storedMark: unknown, currentMark: unknown): boolean {
  try {
    return toMark(storedMark) === toMark(currentMark);
  } catch {
    return false;
  }
}

export type GuardedResult<T> =
  | { ok: true; value: T; mark: number }
  | { ok: false; reason: "changed"; before: number; after: number };

/**
 * 쓰는 쪽: 계산 전 번호를 읽고, 계산 뒤 다시 읽어 같을 때만 ok.
 * compute 에러·번호 읽기 에러는 그대로 던진다(부분 결과를 저장하지 않도록).
 * ok 여도 저장 순간까지의 변경은 못 막는다 — 저장은 markUnchangedCondition 조건부 쓰기 권장
 * (조건부 쓰기가 아니어도 mark 를 같이 저장하면 읽는 쪽이 낡은 것을 걸러 낸다).
 */
export async function computeWithFreshnessGuard<T>(
  db: Client,
  scope: ChangeScope,
  compute: () => Promise<T>,
): Promise<GuardedResult<T>> {
  const before = await readChangeMark(db, scope);
  const value = await compute();
  const after = await readChangeMark(db, scope);
  if (after !== before) return { ok: false, reason: "changed", before, after };
  return { ok: true, value, mark: before };
}

/** 전역 번호 (tx_change_seq). 에러는 던진다. */
export async function readGlobalChangeSeq(db: Client): Promise<number> {
  return readChangeMark(db, { global: true });
}

export type ChangedComplex = ComplexKey & { seq: number; changedAt: string };

/**
 * sinceSeq 보다 뒤에 바뀐 단지들 (post-sync 재빌드 대상 찾기).
 * tx_change_marks 에 seq 인덱스가 없어 표 전체(단지 수 ≈ 수만 행)를 읽는다 — 요청 경로에서 쓰지 않는다.
 */
export async function listChangedComplexesSince(
  db: Client,
  sinceSeq: number,
  opts: { lawds?: readonly string[] } = {},
): Promise<ChangedComplex[]> {
  const lawds = [...new Set(opts.lawds ?? [])];
  const stmt: InStatement = lawds.length
    ? {
        sql: `SELECT lawd_cd, apt_name_norm, seq, changed_at FROM tx_change_marks
              WHERE lawd_cd IN (${lawds.map(() => "?").join(",")}) AND seq > ?`,
        args: [...lawds, toMark(sinceSeq)],
      }
    : {
        sql: `SELECT lawd_cd, apt_name_norm, seq, changed_at FROM tx_change_marks WHERE seq > ?`,
        args: [toMark(sinceSeq)],
      };
  const rs = await db.execute(stmt);
  return rs.rows.map((r) => ({
    lawdCd: String(r.lawd_cd),
    aptNameNorm: String(r.apt_name_norm),
    seq: toMark(r.seq),
    changedAt: String(r.changed_at),
  }));
}
