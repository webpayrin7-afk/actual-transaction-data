/**
 * region_daily_snapshot 표 준비 — 스크립트·테스트 전용(node fs). 앱 요청 경로에서 import 하지 않는다.
 * 표가 없으면 만들고, 옛 표(열이 적음)에는 새 열만 ALTER TABLE ADD COLUMN 으로 더한다. 문장 하나씩.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

export const REGION_DAILY_SNAPSHOT_MIGRATION =
  "src/lib/db/migrations/20261001_region_daily_snapshot.sql";

const ADDED_COLUMNS: Array<[string, string]> = [
  ["tx_mark", "INTEGER"],
  ["build_seq", "INTEGER"],
  ["months_key", "TEXT"],
  ["hero_date", "TEXT"],
  ["hero_is_today", "INTEGER"],
];

export async function ensureRegionDailySnapshotTable(
  db: Client,
  root: string = process.cwd(),
): Promise<string[]> {
  const ddl = readFileSync(join(root, REGION_DAILY_SNAPSHOT_MIGRATION), "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const stmt of ddl.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  const info = await db.execute(`PRAGMA table_info(region_daily_snapshot)`);
  const have = new Set(info.rows.map((r) => String(r.name)));
  const added: string[] = [];
  for (const [name, type] of ADDED_COLUMNS) {
    if (have.has(name)) continue;
    await db.execute(`ALTER TABLE region_daily_snapshot ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  return added;
}
