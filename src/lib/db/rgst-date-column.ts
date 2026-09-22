import type { Client } from "@libsql/client";

let rgstColCache: boolean | null = null;

export function resetRgstDateColumnCache(): void {
  rgstColCache = null;
}

export async function hasRgstDateColumn(db: Client): Promise<boolean> {
  if (rgstColCache != null) return rgstColCache;
  const info = await db.execute("PRAGMA table_info(transactions)");
  rgstColCache = info.rows.some((row) => String(row.name) === "rgst_date");
  return rgstColCache;
}
