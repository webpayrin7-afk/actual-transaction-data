/**
 * Copy a local commerce snapshot SQLite (materialize-complex-commerce.py) into Turso.
 *
 * Touches ONLY complex_commerce_snapshots / commerce_point_cells / complex_commerce_publications
 * (new tables). Insert-missing-only: ON CONFLICT DO NOTHING — never updates or deletes rows.
 *
 *   ENV_FILE=../../.env.local npx tsx scripts/commerce/apply-commerce-snapshots.ts --local <db> [--apply]
 *
 * Without --apply: dry-run (reads remote keys, prints would-insert counts, writes nothing).
 * Re-running with --apply after a successful apply must report 0 new rows.
 */
import { config } from "dotenv";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

config({ path: process.env.ENV_FILE ?? ".env.local", quiet: true });

const TABLES = [
  "complex_commerce_snapshots",
  "commerce_point_cells",
  "complex_commerce_publications",
] as const;
type Table = (typeof TABLES)[number];

const KEY_COLUMNS: Record<Table, string[]> = {
  complex_commerce_snapshots: ["complex_id", "source_version", "snapshot_version", "radius_m"],
  commerce_point_cells: ["source_version", "snapshot_version", "cell_key"],
  complex_commerce_publications: ["source_version", "snapshot_version"],
};

const MIGRATION = resolve(
  process.cwd(),
  "src/lib/db/migrations/20260924_complex_commerce_snapshots.sql",
);

function maskUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^libsql:/, "https:"));
    const host = u.hostname;
    return `${u.protocol.replace("https:", "libsql:")}//${host.slice(0, 4)}***${host.slice(-12)}`;
  } catch {
    return "***";
  }
}

async function tableExists(db: Client, table: Table): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    args: [table],
  });
  return rs.rows.length > 0;
}

async function columns(db: Client, table: Table): Promise<string[]> {
  const rs = await db.execute(`PRAGMA table_info(${table})`);
  return rs.rows.map((r) => String(r.name));
}

function keyOf(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => String(row[c])).join("\u0001");
}

async function remoteKeys(db: Client, table: Table): Promise<Set<string>> {
  const out = new Set<string>();
  if (!(await tableExists(db, table))) return out;
  const cols = KEY_COLUMNS[table];
  const rs = await db.execute(`SELECT ${cols.join(", ")} FROM ${table}`);
  for (const r of rs.rows) out.add(keyOf(r as Record<string, unknown>, cols));
  return out;
}

async function count(db: Client, table: Table): Promise<number> {
  if (!(await tableExists(db, table))) return 0;
  const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rs.rows[0].n);
}

async function main() {
  const args = process.argv.slice(2);
  const localIdx = args.indexOf("--local");
  const localPath = localIdx >= 0 ? args[localIdx + 1] : null;
  const apply = args.includes("--apply");
  if (!localPath) throw new Error("--local <sqlite> is required");

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");

  const local = createClient({ url: pathToFileURL(resolve(localPath)).href });
  const remote = createClient({ url, authToken: token });
  console.log(`[target] ${maskUrl(url)} mode=${apply ? "APPLY" : "DRY-RUN"}`);

  // Refuse to add a second current pointer for a different version (never modify existing rows).
  if (await tableExists(remote, "complex_commerce_publications")) {
    const cur = await remote.execute(
      "SELECT source_version, snapshot_version FROM complex_commerce_publications WHERE is_current = 1",
    );
    const localPub = await local.execute(
      "SELECT source_version, snapshot_version FROM complex_commerce_publications",
    );
    const lp = localPub.rows[0];
    for (const r of cur.rows) {
      if (r.source_version !== lp.source_version || r.snapshot_version !== lp.snapshot_version) {
        throw new Error(
          `remote already has a different current publication (${r.source_version}/${r.snapshot_version}); switching pointers is a separate, reviewed step`,
        );
      }
    }
  }

  const summary: Record<string, unknown> = {};
  if (apply) {
    await remote.executeMultiple(readFileSync(MIGRATION, "utf8"));
  }

  for (const table of TABLES) {
    const cols = await columns(local, table);
    const keys = await remoteKeys(remote, table);
    const localRows = (await local.execute(`SELECT ${cols.join(", ")} FROM ${table}`)).rows;
    const missing = localRows.filter(
      (r) => !keys.has(keyOf(r as Record<string, unknown>, KEY_COLUMNS[table])),
    );
    const before = await count(remote, table);
    const entry: Record<string, number> = {
      local: localRows.length,
      remoteBefore: before,
      alreadyPresent: localRows.length - missing.length,
      wouldInsert: missing.length,
    };
    if (apply && missing.length) {
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
        .map(() => "?")
        .join(", ")}) ON CONFLICT DO NOTHING`;
      const batchSize = table === "commerce_point_cells" ? 100 : 500;
      let inserted = 0;
      for (let i = 0; i < missing.length; i += batchSize) {
        const chunk = missing.slice(i, i + batchSize);
        let attempt = 0;
        for (;;) {
          try {
            const rs = await remote.batch(
              chunk.map((r) => ({ sql, args: cols.map((c) => r[c]) as InArgs })),
              "write",
            );
            for (const x of rs) inserted += x.rowsAffected;
            break;
          } catch (e) {
            attempt += 1;
            if (attempt >= 4) throw e;
            await new Promise((res) => setTimeout(res, 1000 * attempt));
          }
        }
        if ((i / batchSize) % 20 === 0) {
          console.error(`[apply] ${table} ${Math.min(i + batchSize, missing.length)}/${missing.length}`);
        }
      }
      entry.inserted = inserted;
      entry.remoteAfter = await count(remote, table);
    }
    summary[table] = entry;
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
