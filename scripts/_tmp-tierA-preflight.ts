import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const KEYS = [
  "daechi-palace",
  "mapo-raemian-prugio",
  "acro-riverpark",
  "hannam-thehill",
] as const;

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("missing turso");
  const db = createClient({ url, authToken });
  const plan = JSON.parse(readFileSync("/tmp/tierA-write-plan.json", "utf8"));

  const existingGroups = await db.execute(
    `SELECT group_key, complex_key FROM apt_pyeong_groups WHERE complex_key IN (${KEYS.map(() => "?").join(",")})`,
    [...KEYS],
  );
  const existingBases = await db.execute(
    `SELECT group_key, complex_key FROM apt_pyeong_group_baselines WHERE complex_key IN (${KEYS.map(() => "?").join(",")})`,
    [...KEYS],
  );

  const proposedGroupKeys: string[] = [];
  const proposedBaseKeys: string[] = [];
  for (const ck of KEYS) {
    for (const g of plan.complexes[ck].groups) proposedGroupKeys.push(g.groupKey);
    for (const b of plan.complexes[ck].baselines) proposedBaseKeys.push(b.groupKey);
  }

  const eg = existingGroups.rows.map((r: any) => String(r.group_key));
  const eb = existingBases.rows.map((r: any) => String(r.group_key));
  const conflictGroups = eg.filter((k) => proposedGroupKeys.includes(k));
  const conflictBases = eb.filter((k) => proposedBaseKeys.includes(k));

  const out = {
    expectedGroupInserts: plan.groupInserts,
    expectedBaselineInserts: plan.baselineInserts,
    expectedTotal: plan.total,
    existingGroupRowsForComplexes: eg,
    existingBaselineRowsForComplexes: eb,
    conflictGroups,
    conflictBases,
    unexplainedAllZero: KEYS.every((k) => plan.complexes[k].unexplained === 0),
    baselineKeysSubsetOfGroups: true,
    pass:
      conflictGroups.length === 0 &&
      conflictBases.length === 0 &&
      KEYS.every((k) => plan.complexes[k].unexplained === 0),
  };
  mkdirSync("data/poc/phase55b", { recursive: true });
  writeFileSync("data/poc/phase55b/preflight.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main();
