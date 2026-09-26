/**
 * build-boundaries.py 결과(NDJSON) → map_boundaries. 이 테이블 외 쓰기 없음.
 *
 *   npx tsx scripts/map-boundary/load-boundaries.ts --from=C:/data/boundary/out/boundaries.ndjson          # dry-run
 *   npx tsx scripts/map-boundary/load-boundaries.ts --from=C:/data/boundary/out/boundaries.ndjson --apply
 *
 * 같은 code 행은 모양이 바뀌었을 때만(payload_hash) 갱신. 다시 돌리면 insert·update 0.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getDb } from "../../src/lib/db/client";

const SOURCE = "NGII N3A_G0100000/G0110000 (2025-09)";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

type Row = { code: string; level: "gu" | "dong"; name: string; lat: number; lng: number; rings: number[][][] };

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const from = arg("from");
  if (!from) throw new Error("--from=<ndjson> 이 필요합니다.");
  const apply = process.argv.includes("--apply");

  const rows: Array<Row & { ringsJson: string; hash: string }> = [];
  let skippedEmpty = 0;
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Row;
    if (!/^\d{10}$/.test(r.code) || !r.rings?.length) {
      skippedEmpty++;
      continue;
    }
    const ringsJson = JSON.stringify(r.rings);
    rows.push({ ...r, ringsJson, hash: createHash("sha1").update(`${r.level}|${r.name}|${ringsJson}`).digest("hex") });
  }

  const exists =
    (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_boundaries'")).rows.length > 0;
  const have = new Map<string, string>();
  if (exists) {
    for (const r of (await db.execute("SELECT code, payload_hash FROM map_boundaries")).rows) {
      have.set(String(r.code), String(r.payload_hash));
    }
  }
  const changed = rows.filter((r) => have.get(r.code) !== r.hash);
  const inserts = changed.filter((r) => !have.has(r.code)).length;
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        rows: rows.length,
        gu: rows.filter((r) => r.level === "gu").length,
        dong: rows.filter((r) => r.level === "dong").length,
        skipped_empty: skippedEmpty,
        insert: inserts,
        update: changed.length - inserts,
        unchanged: rows.length - changed.length,
      },
      null,
      2,
    ),
  );
  if (!apply || changed.length === 0) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260927_map_boundaries.sql"), "utf8");
  for (const stmt of ddl
    .split(/;\s*\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)) {
    await db.execute(stmt);
  }
  const now = new Date().toISOString();
  let affected = 0;
  for (let i = 0; i < changed.length; i += 100) {
    const res = await db.batch(
      changed.slice(i, i + 100).map((r) => ({
        sql: `INSERT OR REPLACE INTO map_boundaries (code, level, name, lat, lng, rings, source, payload_hash, built_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.code, r.level, r.name, r.lat, r.lng, r.ringsJson, SOURCE, r.hash, now],
      })),
      "write",
    );
    affected += res.reduce((a, x) => a + x.rowsAffected, 0);
  }
  console.log(JSON.stringify({ applied: affected }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
