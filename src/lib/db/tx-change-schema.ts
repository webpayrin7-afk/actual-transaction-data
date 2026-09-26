/**
 * transactions 변경 표시 스키마(20261001_tx_change_marks.sql) 적용 — 스크립트·테스트 전용(node fs).
 * 앱 요청 경로에서 import 하지 않는다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

export const TX_CHANGE_MIGRATION = "src/lib/db/migrations/20261001_tx_change_marks.sql";

/** 마이그레이션 파일을 문장 단위로 (트리거 BEGIN..END 안의 ; 는 나누지 않음) */
export function txChangeTrackingStatements(root: string = process.cwd()): string[] {
  const text = readFileSync(join(root, TX_CHANGE_MIGRATION), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    buf += `${line}\n`;
    const t = buf.trim();
    if (!t) {
      buf = "";
      continue;
    }
    const isTrigger = /^CREATE\s+TRIGGER/i.test(t);
    if (isTrigger ? /\bEND;\s*$/i.test(t) : /;\s*$/.test(t)) {
      out.push(t.replace(/;\s*$/, ""));
      buf = "";
    }
  }
  if (buf.trim()) throw new Error(`${TX_CHANGE_MIGRATION}: trailing statement without ';'`);
  return out;
}

/** 문장 하나씩 (IF NOT EXISTS — 다시 돌려도 무해). db.batch 쓰지 않음. */
export async function applyTxChangeTracking(db: Client, root?: string): Promise<void> {
  for (const sql of txChangeTrackingStatements(root)) {
    await db.execute(sql);
  }
}
