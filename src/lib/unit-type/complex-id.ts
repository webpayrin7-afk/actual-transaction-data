import type { Client } from "@libsql/client";

/**
 * Resolve canonical complex_id from MOLIT source link.
 * Does not create identities. Returns null if missing or ambiguous.
 */
export async function resolveComplexIdFromMolit(
  db: Client,
  lawdCd: string,
  aptNameNorm: string,
): Promise<string | null> {
  const sourceKey = `${lawdCd}|${aptNameNorm.replace(/\s+/g, "")}`;
  try {
    const res = await db.execute({
      sql: `SELECT complex_id FROM apt_complex_source_links
            WHERE source = 'MOLIT' AND source_key = ?`,
      args: [sourceKey],
    });
    const ids = [
      ...new Set(
        res.rows.map((r) => String((r as Record<string, unknown>).complex_id)),
      ),
    ];
    if (ids.length !== 1) return null;
    const master = await db.execute({
      sql: `SELECT 1 AS ok FROM apt_complex_master WHERE complex_id = ? LIMIT 1`,
      args: [ids[0]],
    });
    if (master.rows.length !== 1) return null;
    return ids[0];
  } catch {
    // Master tables may be absent on older local DBs — fail soft.
    return null;
  }
}

/** Dual-read: prefer complex_id when set, else legacy complex_key. */
export function dualKeyWhere(
  alias: string,
  complexId: string | null | undefined,
  complexKey: string,
): { sql: string; args: string[] } {
  if (complexId) {
    return {
      sql: `(${alias}.complex_id = ? OR (${alias}.complex_id IS NULL AND ${alias}.complex_key = ?))`,
      args: [complexId, complexKey],
    };
  }
  return {
    sql: `${alias}.complex_key = ?`,
    args: [complexKey],
  };
}
