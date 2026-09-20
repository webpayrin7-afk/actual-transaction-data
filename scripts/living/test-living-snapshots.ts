import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { applyLivingDatabase } from "./apply-living-snapshots";
import { readComplexLiving } from "../../src/lib/living/read-snapshot";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
const dir = mkdtempSync(join(tmpdir(), "living-"));
const localPath = join(dir, "local.db");
const remotePath = join(dir, "remote.db");
const local = createClient({ url: `file:${localPath}` });
const remote = createClient({ url: `file:${remotePath}` });

const built = "2026-09-20T00:00:00Z";
await local.executeMultiple(`
CREATE TABLE complex_living_snapshots (
  complex_id TEXT NOT NULL,
  radius_m INTEGER NOT NULL,
  product_category TEXT NOT NULL,
  product_subcategory TEXT NOT NULL,
  facility_count INTEGER NOT NULL,
  quality_status TEXT NOT NULL,
  coordinate_semantics TEXT NOT NULL,
  distance_metric TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  built_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, radius_m, product_category, product_subcategory, source_version, snapshot_version)
);
CREATE TABLE complex_living_readiness (
  complex_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  coordinate_semantics TEXT,
  built_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, source_version, snapshot_version)
);
CREATE TABLE complex_living_publications (
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  is_current INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  complex_count INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (source_version, snapshot_version)
);
CREATE TABLE living_category_rules (
  rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_category_code TEXT NOT NULL,
  source_category_name TEXT NOT NULL,
  product_category TEXT NOT NULL,
  product_subcategory TEXT NOT NULL,
  PRIMARY KEY (rule_version, source_provider, source_category_code)
);
`);

await local.execute({
  sql: `INSERT INTO complex_living_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: [
    "cx_ready", 1000, "MEDICAL", "DENTAL", 2, "COMPLETE",
    "PARCEL_REPRESENTATIVE_POINT", "STRAIGHT_LINE_HAVERSINE",
    "SEMAS", "소상공인시장진흥공단_상가(상권)정보", "SEMAS_2026Q2", "2026-06-30",
    "living_semas_v1", "living_v1", built,
  ],
});
await local.execute({
  sql: `INSERT INTO complex_living_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: [
    "cx_ready", 1000, "FOOD", "KOREAN", 0, "COMPLETE",
    "PARCEL_REPRESENTATIVE_POINT", "STRAIGHT_LINE_HAVERSINE",
    "SEMAS", "소상공인시장진흥공단_상가(상권)정보", "SEMAS_2026Q2", "2026-06-30",
    "living_semas_v1", "living_v1", built,
  ],
});
await local.execute({
  sql: `INSERT INTO complex_living_readiness VALUES (?,?,?,?,?,?)`,
  args: ["cx_ready", "SEMAS_2026Q2", "living_v1", "COMPLETE", "PARCEL_REPRESENTATIVE_POINT", built],
});
await local.execute({
  sql: `INSERT INTO complex_living_readiness VALUES (?,?,?,?,?,?)`,
  args: ["cx_none", "SEMAS_2026Q2", "living_v1", "NO_COORDINATE", null, built],
});
await local.execute({
  sql: `INSERT INTO living_category_rules VALUES (?,?,?,?,?,?)`,
  args: ["living_semas_v1", "SEMAS", "Q10210", "치과의원", "MEDICAL", "DENTAL"],
});
await local.execute({
  sql: `INSERT INTO complex_living_publications VALUES (?,?,?,?,?,?,?,?,?,?)`,
  args: [
    "SEMAS_2026Q2", "living_v1", "living_semas_v1", "SEMAS",
    "소상공인시장진흥공단_상가(상권)정보", "2026-06-30", 1, built, 1, "test",
  ],
});
await remote.executeMultiple(`
CREATE TABLE complex_living_publications (
  source_version TEXT NOT NULL,
  snapshot_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  source_as_of TEXT NOT NULL,
  is_current INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  complex_count INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (source_version, snapshot_version)
);
`);
await remote.execute({
  sql: `INSERT INTO complex_living_publications VALUES (?,?,?,?,?,?,?,?,?,?)`,
  args: [
    "SEMAS_2025Q4", "living_v1", "living_semas_v1", "SEMAS",
    "소상공인시장진흥공단_상가(상권)정보", "2025-12-31", 1, "2025-12-31T00:00:00Z", 1, "old",
  ],
});

const first = await applyLivingDatabase(local, remote, 10);
assert(first.snapshotInserts === 2, `snapshot inserts ${first.snapshotInserts}`);
assert(first.snapshotUpdates === 0, `snapshot updates ${first.snapshotUpdates}`);
assert(first.readinessInserts === 2, `readiness inserts ${first.readinessInserts}`);
assert(first.publicationInserts === 1, `publication inserts ${first.publicationInserts}`);
assert(first.pointerClears === 1, `pointer clears ${first.pointerClears}`);

const second = await applyLivingDatabase(local, remote, 10);
assert(second.snapshotInserts === 0, `rerun snapshot inserts ${second.snapshotInserts}`);
assert(second.snapshotUpdates === 0, `rerun snapshot updates ${second.snapshotUpdates}`);
assert(second.readinessInserts === 0 && second.readinessUpdates === 0, "readiness rerun");
assert(second.ruleInserts === 0 && second.ruleUpdates === 0, "rules rerun");
assert(second.publicationInserts === 0 && second.publicationUpdates === 0, "publication rerun");
assert(second.pointerClears === 0, `rerun pointer ${second.pointerClears}`);

const old = await remote.execute({
  sql: "SELECT is_current FROM complex_living_publications WHERE source_version = ?",
  args: ["SEMAS_2025Q4"],
});
assert(Number(old.rows[0].is_current) === 0, "old version kept but not current");
const kept = await remote.execute({
  sql: "SELECT COUNT(*) AS n FROM complex_living_publications WHERE source_version = ?",
  args: ["SEMAS_2025Q4"],
});
assert(Number(kept.rows[0].n) === 1, "historical publication not deleted");

const ready = await readComplexLiving(remote, "cx_ready", 1000);
assert(ready.qualityStatus === "COMPLETE", ready.qualityStatus);
assert(ready.categories.find((c) => c.category === "MEDICAL")?.count === 2, "medical count");
assert(ready.categories.find((c) => c.category === "FOOD")?.count === 0, "real zero food");
assert(ready.categories.find((c) => c.category === "FOOD")?.subcategories.length === 0, "zero sub omitted");
assert(ready.held.some((h) => h.category === "PARK" && h.qualityStatus === "NO_SOURCE"), "park held");

const missingCoord = await readComplexLiving(remote, "cx_none", 1000);
assert(missingCoord.qualityStatus === "NO_COORDINATE", missingCoord.qualityStatus);
assert(missingCoord.categories.length === 0, "no fake zeros");

const unknown = await readComplexLiving(remote, "cx_unknown", 500);
assert(unknown.qualityStatus === "NO_SNAPSHOT", unknown.qualityStatus);
assert(unknown.categories.length === 0, "unknown has no zeros");

const t0 = performance.now();
await readComplexLiving(remote, "cx_ready", 1000);
const readMs = performance.now() - t0;
assert(readMs < 1000, `read too slow ${readMs}`);

rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ pass: true, readMs: Number(readMs.toFixed(3)), first, second }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
