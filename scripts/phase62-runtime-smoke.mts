import { createClient } from "@libsql/client";
import {
  dualKeyWhere,
  resolveComplexIdFromMolit,
} from "../src/lib/unit-type/complex-id.ts";
import { loadBaselinePriorMaxByComplex } from "../src/lib/unit-type/baselines.ts";
import { loadUnitTypeMasterByAptName } from "../src/lib/unit-type/repository.ts";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const pilots = [
  "hangang-daewoo",
  "parkrio",
  "banpo-xi",
  "jamsil-els",
  "mokdong-7",
  "eunma",
];

for (const key of pilots) {
  const cls = await db.execute({
    sql: `SELECT * FROM apt_complex_classifications WHERE complex_key=?`,
    args: [key],
  });
  const row = cls.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    console.log(JSON.stringify({ key, status: "MISSING" }));
    continue;
  }
  const resolved = await resolveComplexIdFromMolit(
    db,
    String(row.lawd_cd),
    String(row.apt_name_norm),
  );
  const bundle = await loadUnitTypeMasterByAptName(
    String(row.apt_name_norm),
    db,
  );
  const baselines = await loadBaselinePriorMaxByComplex(
    db,
    key,
    row.complex_id == null ? null : String(row.complex_id),
  );
  const gCount = (
    await db.execute({
      sql: `SELECT COUNT(*) AS c FROM apt_pyeong_groups WHERE complex_key=?`,
      args: [key],
    })
  ).rows[0].c;
  console.log(
    JSON.stringify({
      key,
      storedId: row.complex_id,
      resolved,
      class: row.classification,
      mode: row.singoga_mode,
      bundleGroups: bundle?.groups.length ?? null,
      dbGroups: gCount,
      baselineKeys: baselines.size,
    }),
  );
}

const mapo = await loadUnitTypeMasterByAptName("마포래미안푸르지오4단지", db);
console.log(
  JSON.stringify({
    mapoId: mapo?.classification.complexId ?? null,
    mapoGroups: mapo?.groups.length ?? null,
  }),
);

const orphan = await db.execute(`
  SELECT COUNT(*) AS c
  FROM apt_complex_classifications c
  LEFT JOIN apt_complex_master m ON m.complex_id = c.complex_id
  WHERE c.complex_id IS NOT NULL AND m.complex_id IS NULL
`);
const mismatch = await db.execute(`
  SELECT COUNT(*) AS c
  FROM apt_pyeong_group_baselines b
  JOIN apt_pyeong_groups g ON g.group_key = b.group_key
  WHERE b.complex_id IS NOT NULL
    AND g.complex_id IS NOT NULL
    AND b.complex_id != g.complex_id
`);
console.log(
  JSON.stringify({
    classOrphans: orphan.rows[0].c,
    baselineGroupMismatch: mismatch.rows[0].c,
    dualKeySample: dualKeyWhere("g", "cx_x", "banpo-xi"),
  }),
);
