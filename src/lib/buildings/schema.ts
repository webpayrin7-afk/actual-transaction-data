import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

const MIGRATION = "src/lib/db/migrations/20260920_complex_buildings.sql";

export async function ensureBuildingSchema(db: Client): Promise<void> {
  const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
  const chunks = sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  for (const chunk of chunks) {
    await db.execute(chunk);
  }
}
