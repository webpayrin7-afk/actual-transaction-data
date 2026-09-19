/**
 * Read-only load of master / KAPT link / fee presence.
 * Does not write Production and does not print row dumps.
 */
import { createClient, type Client } from "@libsql/client";
import { assertReadOnlySql } from "./real-sample";
import type { ComplexInput } from "./national-inventory";

const MASTER_SQL = `
  SELECT complex_id, sido, sido_code
  FROM apt_complex_master
`;
const LINK_SQL = `
  SELECT complex_id, source_key
  FROM apt_complex_source_links
  WHERE source = 'KAPT'
`;
const FEE_SQL = `
  SELECT DISTINCT complex_id
  FROM apt_complex_mgmt_fee_monthly
`;

export async function readNationalComplexes(db: Client): Promise<ComplexInput[]> {
  for (const sql of [MASTER_SQL, LINK_SQL, FEE_SQL]) assertReadOnlySql(sql);
  const masters = await db.execute(MASTER_SQL);
  const links = await db.execute(LINK_SQL);
  const fees = await db.execute(FEE_SQL);
  const codes = new Map<string, string[]>();
  for (const row of links.rows) {
    const id = String(row.complex_id);
    const list = codes.get(id) ?? [];
    list.push(String(row.source_key));
    codes.set(id, list);
  }
  const loaded = new Set(fees.rows.map((row) => String(row.complex_id)));
  return masters.rows.map((row) => ({
    complex_id: String(row.complex_id),
    sido: row.sido == null ? "" : String(row.sido),
    sido_code: row.sido_code == null ? "" : String(row.sido_code),
    kapt_codes: codes.get(String(row.complex_id)) ?? [],
    has_fee: loaded.has(String(row.complex_id)),
  }));
}

export function openReadOnlyClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  return createClient({ url, authToken });
}
