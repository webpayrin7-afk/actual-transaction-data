/**
 * Export apt_complex_master coordinates for the living materializer.
 * Read-only. Does not geocode and does not write Turso.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";

const out = process.argv[2];
if (!out) {
  console.error("usage: export-complex-coordinates.mjs <out.jsonl>");
  process.exit(1);
}
const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!url || !authToken) throw new Error("TURSO env missing");

const db = createClient({ url, authToken });
await mkdir(dirname(out), { recursive: true });
const stream = createWriteStream(out);
let offset = 0;
const page = 1000;
let total = 0;
for (;;) {
  const rs = await db.execute({
    sql: `SELECT complex_id, apt_name, sido, sido_code, sigungu, latitude, longitude
          FROM apt_complex_master
          ORDER BY complex_id
          LIMIT ? OFFSET ?`,
    args: [page, offset],
  });
  if (rs.rows.length === 0) break;
  for (const row of rs.rows) {
    stream.write(`${JSON.stringify(row)}\n`);
    total += 1;
  }
  offset += rs.rows.length;
  if (rs.rows.length < page) break;
}
await new Promise((resolve, reject) => {
  stream.end(() => resolve(undefined));
  stream.on("error", reject);
});
console.log(JSON.stringify({ exported: total, out }));
