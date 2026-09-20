import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const total = num((await db.execute(`SELECT COUNT(*) n FROM apt_unit_supply_conflicts`)).rows[0]?.n);
  const reasons = await db.execute(`SELECT reason, COUNT(*) n FROM apt_unit_supply_conflicts GROUP BY 1`);
  // page through in chunks via rowid-like conflict_id order
  let offset = 0;
  const classes = {
    precision_only: 0,
    genuinely_different_variant: 0,
    empty_incoming: 0,
    other: 0,
  };
  const samples: unknown[] = [];
  while (offset < total) {
    const rows = await db.execute({
      sql: `SELECT conflict_id, exclusive_cents, held_supply_cents, held_source, provenance_json
            FROM apt_unit_supply_conflicts
            ORDER BY conflict_id
            LIMIT 500 OFFSET ?`,
      args: [offset],
    });
    if (!rows.rows.length) break;
    for (const row of rows.rows) {
      let incoming: Array<[number, number]> = [];
      try {
        const p = JSON.parse(String(row.provenance_json || "{}")) as { incoming?: unknown };
        if (Array.isArray(p.incoming)) {
          incoming = p.incoming.filter((x) => Array.isArray(x) && x.length >= 2) as Array<[number, number]>;
        }
      } catch {
        classes.other += 1;
        continue;
      }
      if (!incoming.length) {
        classes.empty_incoming += 1;
        continue;
      }
      const held = num(row.held_supply_cents) / 100;
      const heldEx = num(row.exclusive_cents) / 100;
      const close = incoming.some((pair) => Math.abs(Number(pair[0]) - heldEx) < 0.02 && Math.abs(Number(pair[1]) - held) <= 0.05);
      const sameExDifferent = incoming.some((pair) => Math.abs(Number(pair[0]) - heldEx) < 0.001 && Math.abs(Number(pair[1]) - held) > 0.05);
      if (close && !sameExDifferent) classes.precision_only += 1;
      else if (sameExDifferent) classes.genuinely_different_variant += 1;
      else classes.other += 1;
      if (samples.length < 6) samples.push({ heldEx, held, incoming: incoming.slice(0, 3), cls: close ? "precision" : sameExDifferent ? "variant" : "other" });
    }
    offset += rows.rows.length;
    if (offset % 2000 === 0) console.log(JSON.stringify({ offset, classes }));
  }
  const report = { total, reasons: reasons.rows, classes, samples };
  writeFileSync("/tmp/building-hub-bulk/external-evidence/conflict-audit.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main();
