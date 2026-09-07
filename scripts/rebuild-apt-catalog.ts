/**
 * apt_catalog 재구축 (자동완성 가속)
 *   npx tsx scripts/rebuild-apt-catalog.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { resolve } from "node:path";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { rebuildAptCatalog } from "../src/lib/db/repository";

async function main() {
  if (!process.env.TURSO_DATABASE_URL) {
    process.env.TURSO_DATABASE_URL = `file:${resolve("data/molit.db")}`;
  }
  const db = getDb();
  if (!db) {
    console.error("DB unavailable");
    process.exit(1);
  }
  await ensureSchema(db);
  const n = await rebuildAptCatalog();
  console.log(`[catalog] rebuilt entries=${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
