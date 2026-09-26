/**
 * 거래 변경 표시(tx_change_seq / tx_change_marks + transactions 트리거 4개)가 실제로 설치돼 있는지 — sqlite_master 로 확인.
 *
 * 표만 있고 트리거가 없으면 번호가 절대 바뀌지 않아 "번호 같음 = 최신"이 거짓이 된다.
 * 그래서 스냅샷을 믿기 전(읽기)과 저장하기 전(빌더)에 트리거 4개가 transactions 에 걸려 있는지 본다.
 * 스냅샷 표도 같이 넘기면 그 표·필요한 열이 있는지 같은 한 번의 SELECT 로 본다
 * (옛 표에 새 열이 없을 때 요청마다 실패하는 쿼리를 보내지 않도록).
 *
 * 비용: sqlite_master 는 인덱스가 없어 전체를 읽는다 (Production 2026-09-26 측정 rows_read 278/회).
 * 요청 경로는 createSnapshotSchemaGate 로 인스턴스당 짧게 캐시한다.
 */
import type { Client } from "@libsql/client";

export const TX_CHANGE_TABLES = ["tx_change_seq", "tx_change_marks"] as const;
/** src/lib/db/migrations/20261001_tx_change_marks.sql 의 트리거 이름 — 바꾸면 여기도 */
export const TX_CHANGE_TRIGGERS = [
  "trg_tx_change_ai",
  "trg_tx_change_au",
  "trg_tx_change_au_old",
  "trg_tx_change_ad",
] as const;

export type RequiredTable = { name: string; columns?: readonly string[] };

export type SnapshotSchemaStatus = {
  ready: boolean;
  /** 없는 것: "table:x", "trigger:x", "column:x.y" */
  missing: string[];
};

/**
 * 트리거·변경 표시 표·(선택) 스냅샷 표와 열이 모두 있는가. 한 번의 SELECT.
 * 쿼리 에러는 던진다 — 부르는 쪽이 결정(빌더는 멈춤, 읽기는 라이브).
 */
export async function readSnapshotSchemaStatus(
  db: Client,
  tables: readonly RequiredTable[] = [],
): Promise<SnapshotSchemaStatus> {
  const tableNames = [...TX_CHANGE_TABLES, ...tables.map((t) => t.name)];
  const names = [...tableNames, ...TX_CHANGE_TRIGGERS];
  const res = await db.execute({
    sql: `SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE name IN (${names.map(() => "?").join(",")})`,
    args: names,
  });
  const found = new Map<string, { type: string; tblName: string; sql: string }>();
  for (const row of res.rows) {
    found.set(String(row.name), {
      type: String(row.type),
      tblName: String(row.tbl_name ?? ""),
      sql: String(row.sql ?? ""),
    });
  }
  const missing: string[] = [];
  for (const name of tableNames) {
    if (found.get(name)?.type !== "table") missing.push(`table:${name}`);
  }
  for (const name of TX_CHANGE_TRIGGERS) {
    const hit = found.get(name);
    if (hit?.type !== "trigger" || hit.tblName.toLowerCase() !== "transactions") {
      missing.push(`trigger:${name}`);
    }
  }
  for (const table of tables) {
    const hit = found.get(table.name);
    if (hit?.type !== "table") continue;
    // ALTER TABLE ADD COLUMN 도 sqlite_master.sql 에 반영된다
    for (const col of table.columns ?? []) {
      if (!new RegExp(`\\b${col}\\b`, "i").test(hit.sql)) missing.push(`column:${table.name}.${col}`);
    }
  }
  return { ready: missing.length === 0, missing };
}

/** 스키마가 없어서 난 에러인가 (그때만 게이트를 닫는다 — 네트워크 에러로 끄지 않음) */
export function isMissingSchemaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /no such (table|column)/i.test(msg);
}

export type SnapshotSchemaGate = {
  /** 캐시가 살아 있으면 왕복 없음. 확인 에러는 false(라이브) 로 짧게 캐시. */
  isReady(db: Client): Promise<boolean>;
  /** 읽기에서 스키마 에러가 났을 때 — 다음 확인까지 닫는다 */
  markMissing(reason: string): void;
  /** 테스트 전용 */
  reset(): void;
};

/**
 * 인스턴스당 캐시된 확인.
 * - 있음: readyTtlMs(기본 2분) 동안 믿는다 — 트리거가 지워지면 그 안에 알아챈다.
 * - 없음: missingTtlMs(기본 5분) 동안 확인도 스냅샷 SELECT 도 하지 않는다 (요청마다 실패 쿼리 없음).
 * - 확인 쿼리 에러: errorTtlMs(기본 1분) 동안 없음으로.
 * 동시에 들어온 요청은 한 확인을 같이 기다린다.
 */
export function createSnapshotSchemaGate(opts: {
  label: string;
  tables: readonly RequiredTable[];
  readyTtlMs?: number;
  missingTtlMs?: number;
  errorTtlMs?: number;
}): SnapshotSchemaGate {
  const readyTtl = opts.readyTtlMs ?? 120_000;
  const missingTtl = opts.missingTtlMs ?? 300_000;
  const errorTtl = opts.errorTtlMs ?? 60_000;
  let state: { ready: boolean; until: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  let lastLogged: string | null = null;

  function log(key: string, line: string) {
    if (lastLogged === key) return;
    lastLogged = key;
    console.warn(`[${opts.label}] ${line}`);
  }

  return {
    async isReady(db) {
      const now = Date.now();
      if (state && state.until > now) return state.ready;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const status = await readSnapshotSchemaStatus(db, opts.tables);
          state = { ready: status.ready, until: Date.now() + (status.ready ? readyTtl : missingTtl) };
          if (status.ready) {
            lastLogged = null;
          } else {
            log(`missing:${status.missing.join(",")}`, `snapshot OFF — missing ${status.missing.join(", ")}`);
          }
          return status.ready;
        } catch (error) {
          state = { ready: false, until: Date.now() + errorTtl };
          log(
            "error",
            `snapshot OFF — schema check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    markMissing(reason) {
      state = { ready: false, until: Date.now() + missingTtl };
      log(`markMissing:${reason}`, `snapshot OFF — ${reason}`);
    },
    reset() {
      state = null;
      inflight = null;
      lastLogged = null;
    },
  };
}
