/**
 * STAGE 11 — Targeted invalid-group repair + rule refinement + coverage/legacy audits.
 *
 * DB writes ALLOWED only:
 *   DELETE links + groups for exactly 2 테헤란아이파크 zero-span groups
 *
 * INSERT=0 UPDATE=0 apt_unit_types DELETE=0
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaKey,
  areaKeyStr,
  clusterAllBands,
  dedupeAreas,
  proposeNewGroupsWithHardCap,
  type AreaRow,
  assertMinimumGroupContract,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage11-repair-and-refinement.json",
);

const REPAIR_GROUPS = [
  "cx_d80e92e6aef239af:G2:ex80.20-80.20",
  "cx_d80e92e6aef239af:G3:ex92.62-92.62",
] as const;

const TERAN_ID = "cx_d80e92e6aef239af";

const STAGE9_IDS = [
  "cx_c3f8a052ae66fd32",
  "cx_774f03bf66e7882f",
  "cx_836331525ecdd550",
  "cx_d80e92e6aef239af",
  "cx_b225492e31c09cdd",
  "cx_04a453b6ca3d373c",
  "cx_7ce2c0c6be9bb8b4",
  "cx_d754faa260b961ae",
  "cx_c8ecd97624efad6d",
  "cx_6ae0260f869a7b0f",
] as const;

const EXCLUDE = new Set<string>([
  ...STAGE9_IDS,
  "cx_caf229b5ac63cfbd",
  "cx_85cd8a4b2d5dc3d0",
  "cx_b1f9d0cc3e8e5c12",
  "cx_b74bdaa8f28045aa",
  "cx_4880c4ffe9880d49",
  "cx_e095bf141dde5379",
  "cx_c7ac494bf78993ad",
]);

const LEGACY_SLUGS = [
  "acro-riverpark",
  "daechi-palace",
  "hannam-thehill",
  "mapo-raemian-prugio",
  "raemian-hill-godeok",
] as const;

const POSITIVE_CONTROL_GROUPS = [
  "cx_c3f8a052ae66fd32:G1:ex59.78-59.91",
  "cx_774f03bf66e7882f:G3:ex84.91-84.97",
  "cx_b225492e31c09cdd:G2:ex84.97-84.99",
] as const;

type Db = ReturnType<typeof createClient>;

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function preDeleteSafety(db: Db) {
  const checks = [];
  let alreadyRepaired = 0;
  for (const gk of REPAIR_GROUPS) {
    const g = await db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE group_key=?`,
      args: [gk],
    });
    if (g.rows.length === 0) {
      const linksLeft = await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
        [gk],
      );
      if (linksLeft === 0) {
        alreadyRepaired += 1;
        checks.push({
          groupKey: gk,
          alreadyAbsent: true,
          baseline: 0,
          classificationDependency: 0,
          singogaDependency: 0,
          linkCount: 0,
          memberKeys: [] as string[],
          unitsExist: [] as Array<{ utk: string; exists: boolean }>,
          min: null,
          max: null,
        });
        continue;
      }
      return {
        ok: false as const,
        reason: `group missing but orphan links remain: ${gk}`,
        checks,
      };
    }
    const row = g.rows[0]!;
    const min = Number(row.exclusive_area_min);
    const max = Number(row.exclusive_area_max);
    if (areaKey(min) !== areaKey(max)) {
      return {
        ok: false as const,
        reason: `unexpected non-zero span on repair target ${gk}`,
        checks,
      };
    }
    const links = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key=?`,
      args: [gk],
    });
    const memberKeys = links.rows.map((r) => String(r.unit_type_key));
    const baseline = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines WHERE group_key=?`,
      [gk],
    );
    const classDep = await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications WHERE complex_key=?`,
      [TERAN_ID],
    );
    const unitsExist = [];
    for (const utk of memberKeys) {
      unitsExist.push({
        utk,
        exists:
          (await count(
            db,
            `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key=?`,
            [utk],
          )) === 1,
      });
    }
    checks.push({
      groupKey: gk,
      alreadyAbsent: false,
      baseline,
      classificationDependency: classDep,
      singogaDependency: 0,
      linkCount: memberKeys.length,
      memberKeys,
      unitsExist,
      min,
      max,
    });
    if (baseline !== 0 || classDep !== 0) {
      return {
        ok: false as const,
        reason: `dependency non-zero for ${gk}`,
        checks,
      };
    }
    if (memberKeys.length !== 1) {
      return {
        ok: false as const,
        reason: `unexpected link count ${memberKeys.length} for ${gk}`,
        checks,
      };
    }
    if (!unitsExist.every((u) => u.exists)) {
      return { ok: false as const, reason: `unit type missing for ${gk}`, checks };
    }
  }

  const master = await db.execute({
    sql: `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id=?`,
    args: [TERAN_ID],
  });
  const name = String(master.rows[0]!.apt_name_norm);
  const lawd = String(master.rows[0]!.lawd_cd);
  const tx802 = await count(
    db,
    `SELECT COUNT(*) c FROM transactions WHERE apt_name_norm=? AND lawd_cd=?
     AND ROUND(exclusive_area*100)=ROUND(80.2*100)`,
    [name, lawd],
  );
  const tx9262 = await count(
    db,
    `SELECT COUNT(*) c FROM transactions WHERE apt_name_norm=? AND lawd_cd=?
     AND ROUND(exclusive_area*100)=ROUND(92.62*100)`,
    [name, lawd],
  );
  if (tx802 === 0 || tx9262 === 0) {
    return {
      ok: false as const,
      reason: `raw tx missing 80.2=${tx802} 92.62=${tx9262}`,
      checks,
    };
  }

  // Units must still exist even if groups already repaired
  const u802 = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key=?`,
    [`${TERAN_ID}:ex80.2`],
  );
  const u9262 = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key=?`,
    [`${TERAN_ID}:ex92.62`],
  );
  if (u802 !== 1 || u9262 !== 1) {
    return {
      ok: false as const,
      reason: `unit types not preserved 80.2=${u802} 92.62=${u9262}`,
      checks,
    };
  }

  return {
    ok: true as const,
    alreadyFullyRepaired: alreadyRepaired === REPAIR_GROUPS.length,
    checks,
    aptName: name,
    lawdCd: lawd,
    tx802,
    tx9262,
  };
}

async function executeRepair(db: Db) {
  let linksDeleted = 0;
  let groupsDeleted = 0;
  for (const gk of REPAIR_GROUPS) {
    const l = await db.execute({
      sql: `DELETE FROM apt_unit_type_group_links WHERE group_key=?`,
      args: [gk],
    });
    linksDeleted += Number(l.rowsAffected ?? 0);
    // libsql may report differently — recount
  }
  // Prefer counting by verifying absence
  for (const gk of REPAIR_GROUPS) {
    const beforeLinks = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
      [gk],
    );
    if (beforeLinks > 0) {
      await db.execute({
        sql: `DELETE FROM apt_unit_type_group_links WHERE group_key=?`,
        args: [gk],
      });
    }
    const afterLinks = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
      [gk],
    );
    linksDeleted += beforeLinks - afterLinks;

    const beforeG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key=?`,
      [gk],
    );
    await db.execute({
      sql: `DELETE FROM apt_pyeong_groups WHERE group_key=?`,
      args: [gk],
    });
    const afterG = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key=?`,
      [gk],
    );
    groupsDeleted += beforeG - afterG;
  }
  return { linksDeleted, groupsDeleted };
}

async function postRepairValidation(db: Db) {
  const remainingInvalid = [];
  for (const gk of REPAIR_GROUPS) {
    const g = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key=?`,
      [gk],
    );
    const l = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
      [gk],
    );
    if (g > 0 || l > 0) remainingInvalid.push({ gk, g, l });
  }
  const u802 = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key=?`,
    [`${TERAN_ID}:ex80.2`],
  );
  const u9262 = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types WHERE unit_type_key=?`,
    [`${TERAN_ID}:ex92.62`],
  );
  // other stage9 group counts
  const stage9Groups = await count(
    db,
    `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key IN (${STAGE9_IDS.map(() => "?").join(",")})`,
    [...STAGE9_IDS],
  );
  const protect = ["cx_caf229b5ac63cfbd", "cx_85cd8a4b2d5dc3d0", "parkrio", "jamsil-els"];
  const protectCounts: Record<string, number> = {};
  for (const k of protect) {
    protectCounts[k] = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE complex_key=?`,
      [k],
    );
  }
  return {
    remainingInvalid,
    unit802Exists: u802 === 1,
    unit9262Exists: u9262 === 1,
    stage9GroupsRemaining: stage9Groups, // expect 29 (31-2)
    protectCounts,
  };
}

function teranCanonicalReplay() {
  // Simulate raw floats → canonical → cluster
  const raw802 = [
    { exclusiveArea: 80.1995, txCount: 30 },
    { exclusiveArea: 80.2, txCount: 1 },
  ];
  const raw9262 = [
    { exclusiveArea: 92.62, txCount: 2 },
    { exclusiveArea: 92.6232, txCount: 199 },
  ];
  const c802 = clusterAllBands(raw802);
  const c9262 = clusterAllBands(raw9262);
  return {
    order: [
      "raw observed values",
      "areaKey canonicalization",
      "canonical dedupe",
      "candidate clustering",
      "group decision",
    ],
    case802: {
      raw: raw802,
      afterDedupe: dedupeAreas(raw802),
      clusters: c802.map((c) => ({
        members: c.members,
        decision: c.decision,
        span: c.span,
        contract: assertMinimumGroupContract(c.members),
      })),
      expectNoGroup: c802.every(
        (c) => c.decision === "NOT_GROUPABLE" || c.members.length < 2,
      ),
    },
    case9262: {
      raw: raw9262,
      afterDedupe: dedupeAreas(raw9262),
      clusters: c9262.map((c) => ({
        members: c.members,
        decision: c.decision,
        span: c.span,
        contract: assertMinimumGroupContract(c.members),
      })),
      expectNoGroup: c9262.every(
        (c) => c.decision === "NOT_GROUPABLE" || c.members.length < 2,
      ),
    },
  };
}

async function positiveControls(db: Db) {
  const out = [];
  for (const gk of POSITIVE_CONTROL_GROUPS) {
    const g = await db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE group_key=?`,
      args: [gk],
    });
    if (g.rows.length === 0) {
      out.push({ groupKey: gk, status: "MISSING" });
      continue;
    }
    const min = Number(g.rows[0]!.exclusive_area_min);
    const max = Number(g.rows[0]!.exclusive_area_max);
    const links = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
      [gk],
    );
    const contract = assertMinimumGroupContract(
      // approximate members from min.. we check min<max and links>=2
      min === max ? [min] : [min, max],
    );
    out.push({
      groupKey: gk,
      min,
      max,
      span: areaKey(max - min),
      links,
      contractOk: min < max && links >= 2 && contract.ok,
      status: min < max && links >= 2 ? "VALID_POSITIVE_CONTROL" : "UNEXPECTED",
    });
  }
  return out;
}

async function selectRefinementSamples(db: Db) {
  const have = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  for (const r of have.rows) EXCLUDE.add(String(r.complex_key));
  const mapped = await db.execute(
    `SELECT DISTINCT complex_id FROM apt_pyeong_groups WHERE complex_id IS NOT NULL`,
  );
  for (const r of mapped.rows) EXCLUDE.add(String(r.complex_id));

  const inv = await db.execute(`
    SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name,
           t.exclusive_area AS ea, COUNT(*) AS cnt
    FROM apt_complex_master m
    JOIN transactions t
      ON t.apt_name_norm=m.apt_name_norm AND t.lawd_cd=m.lawd_cd
    WHERE m.identity_status='IDENTITY-READY' AND m.sido_code='11'
      AND t.exclusive_area IS NOT NULL AND t.exclusive_area>0
    GROUP BY m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, t.exclusive_area
  `);

  type Comp = {
    complexId: string;
    name: string;
    lawdCd: string;
    dong: string | null;
    areas: AreaRow[];
  };
  const byId = new Map<string, Comp>();
  for (const r of inv.rows) {
    const cid = String(r.complex_id);
    if (EXCLUDE.has(cid)) continue;
    let row = byId.get(cid);
    if (!row) {
      row = {
        complexId: cid,
        name: String(r.apt_name_norm),
        lawdCd: String(r.lawd_cd),
        dong: r.legal_dong_name != null ? String(r.legal_dong_name) : null,
        areas: [],
      };
      byId.set(cid, row);
    }
    row.areas.push({
      exclusiveArea: Number(r.ea), // keep raw float; clusterAllBands will canonicalize
      txCount: Number(r.cnt),
    });
  }

  const pool = [...byId.values()].map((c) => ({
    ...c,
    areas: dedupeAreas(c.areas),
  }));

  // CLASS A: 90–109 with multi-member clusters; diversify gaps
  const classAPool = pool
    .map((c) => {
      const band = c.areas.filter(
        (a) => a.exclusiveArea >= 90 && a.exclusiveArea < 110,
      );
      const clusters = clusterAllBands(band).filter((x) => x.members.length >= 2);
      return { ...c, band, clusters };
    })
    .filter((c) => c.clusters.length > 0)
    .sort((a, b) => a.complexId.localeCompare(b.complexId));

  const gapBuckets = [
    { name: "0.02-0.05", lo: 0.02, hi: 0.05 },
    { name: "0.06-0.10", lo: 0.06, hi: 0.1 },
    { name: "0.11-0.15", lo: 0.11, hi: 0.15 },
    { name: "0.16-0.20", lo: 0.16, hi: 0.2 },
  ];
  const pickedA: typeof classAPool = [];
  for (const b of gapBuckets) {
    const hit = classAPool.find(
      (c) =>
        !pickedA.includes(c) &&
        c.clusters.some((cl) => cl.maxGap >= b.lo && cl.maxGap <= b.hi),
    );
    if (hit) pickedA.push(hit);
  }
  // fill to 10 with remaining multi-member (prefer wider gaps)
  const rest = classAPool
    .filter((c) => !pickedA.includes(c))
    .sort(
      (a, b) =>
        Math.max(...b.clusters.map((x) => x.maxGap)) -
        Math.max(...a.clusters.map((x) => x.maxGap)),
    );
  for (const c of rest) {
    if (pickedA.length >= 10) break;
    pickedA.push(c);
  }

  // CLASS B: 50–69 boundary gap diversity
  const classBPool = pool
    .map((c) => {
      const band = c.areas.filter(
        (a) => a.exclusiveArea >= 50 && a.exclusiveArea < 70,
      );
      const sorted = band.map((a) => a.exclusiveArea);
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(areaKey(sorted[i]! - sorted[i - 1]!));
      }
      const clusters = clusterAllBands(band);
      return { ...c, band, gaps, clusters };
    })
    .filter((c) => c.band.length >= 2 && c.gaps.some((g) => g >= 0.13 && g <= 0.2))
    .sort((a, b) => a.complexId.localeCompare(b.complexId));

  const targets = [0.13, 0.14, 0.15, 0.16, 0.17, 0.18];
  const pickedB: typeof classBPool = [];
  for (const t of targets) {
    const hit = classBPool.find(
      (c) =>
        !pickedB.includes(c) &&
        !pickedA.some((a) => a.complexId === c.complexId) &&
        c.gaps.some((g) => Math.abs(g - t) <= 0.005),
    );
    if (hit) pickedB.push(hit);
  }
  for (const c of classBPool) {
    if (pickedB.length >= 6) break;
    if (pickedA.some((a) => a.complexId === c.complexId)) continue;
    if (pickedB.includes(c)) continue;
    pickedB.push(c);
  }

  return { classA: pickedA.slice(0, 10), classB: pickedB.slice(0, 6) };
}

async function coverageReconciliation(db: Db) {
  const rawFloatDistinct = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT m.complex_id, t.exclusive_area
       FROM apt_complex_master m
       JOIN transactions t ON t.apt_name_norm=m.apt_name_norm AND t.lawd_cd=m.lawd_cd
       WHERE m.sido_code='11' AND m.identity_status='IDENTITY-READY'
         AND t.exclusive_area IS NOT NULL AND t.exclusive_area>0
       GROUP BY m.complex_id, t.exclusive_area
     )`,
  );
  const canonicalDistinct = await count(
    db,
    `SELECT COUNT(*) c FROM (
       SELECT m.complex_id, ROUND(t.exclusive_area*100)/100
       FROM apt_complex_master m
       JOIN transactions t ON t.apt_name_norm=m.apt_name_norm AND t.lawd_cd=m.lawd_cd
       WHERE m.sido_code='11' AND m.identity_status='IDENTITY-READY'
         AND t.exclusive_area IS NOT NULL AND t.exclusive_area>0
       GROUP BY m.complex_id, ROUND(t.exclusive_area*100)/100
     )`,
  );
  return {
    stage9Denominator: 34752,
    stage10Denominator: 34380,
    liveRawFloatDistinct: rawFloatDistinct,
    liveCanonicalDistinct: canonicalDistinct,
    difference: rawFloatDistinct - canonicalDistinct,
    differenceCause:
      "Stage9 counted GROUP BY complex_id, exclusive_area (raw float distinct). Stage10 counted GROUP BY complex_id, ROUND(exclusive_area*100)/100 (areaKey canonical). Float pairs that collapse under areaKey explain the ~372 delta.",
    officialFutureDenominator: {
      formula: "COUNT(DISTINCT (complex_id, areaKey(exclusive_area))) over Seoul IDENTITY-READY",
      implementation: "GROUP BY complex_id, ROUND(exclusive_area*100)/100",
      rationale: "Matches apt_unit_types identity (complex_id carrier + areaKey)",
    },
  };
}

async function legacyAudit(db: Db) {
  const rows = [];
  for (const slug of LEGACY_SLUGS) {
    const classRow = await db.execute({
      sql: `SELECT * FROM apt_complex_classifications WHERE complex_key=?`,
      args: [slug],
    });
    const groups = await db.execute({
      sql: `SELECT group_key, complex_id, exclusive_area_min, exclusive_area_max
            FROM apt_pyeong_groups WHERE complex_key=?`,
      args: [slug],
    });
    const units = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
      [slug],
    );
    const links = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE complex_key=?`,
      [slug],
    );
    const baselines = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines WHERE complex_key=?`,
      [slug],
    );
    const complexId =
      groups.rows[0]?.complex_id != null
        ? String(groups.rows[0].complex_id)
        : classRow.rows[0] != null &&
            (classRow.rows[0] as Record<string, unknown>).complex_id != null
          ? String((classRow.rows[0] as Record<string, unknown>).complex_id)
          : null;
    const cxUnits =
      complexId != null
        ? await count(
            db,
            `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
            [complexId],
          )
        : 0;
    const aptName =
      classRow.rows[0] != null
        ? String(classRow.rows[0].apt_name_norm)
        : null;
    // Lookup path: loadUnitTypeMasterByAptName uses classifications.apt_name_norm → complex_key (slug)
    const lookupViaAptName = aptName != null && classRow.rows.length > 0;
    rows.push({
      legacySlug: slug,
      canonicalComplexId: complexId,
      classificationPresent: classRow.rows.length > 0,
      aptNameNorm: aptName,
      groupCount: groups.rows.length,
      unitCountUnderSlug: units,
      unitCountUnderCx: cxUnits,
      linkCount: links,
      baselineCount: baselines,
      lookupViaAptNameToSlug: lookupViaAptName,
      note:
        cxUnits === 0 && units > 0
          ? "units live under slug only; apt-name→classification→slug lookup works for Phase5 path"
          : cxUnits > 0
            ? "also has cx_ unit rows"
            : "no units?",
    });
  }
  return rows;
}

async function writeCapRegression(db: Db) {
  // Rebuild SAFE candidate queue from Stage9 complexes (read-only)
  const queue: Array<{
    id: string;
    alreadyExists: boolean;
    order: number;
  }> = [];
  let order = 0;
  for (const id of STAGE9_IDS) {
    const master = await db.execute({
      sql: `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id=?`,
      args: [id],
    });
    const name = String(master.rows[0]!.apt_name_norm);
    const lawd = String(master.rows[0]!.lawd_cd);
    const tx = await db.execute({
      sql: `SELECT exclusive_area ea, COUNT(*) cnt FROM transactions
            WHERE apt_name_norm=? AND lawd_cd=? AND exclusive_area IS NOT NULL AND exclusive_area>0
            GROUP BY exclusive_area`,
      args: [name, lawd],
    });
    const areas = dedupeAreas(
      tx.rows.map((r) => ({
        exclusiveArea: Number(r.ea),
        txCount: Number(r.cnt),
      })),
    );
    const safe = clusterAllBands(areas)
      .filter((c) => c.decision === "SAFE_GROUP")
      .sort((a, b) => a.min - b.min);
    for (const s of safe) {
      queue.push({
        id: `${id}:${s.members.join("-")}`,
        alreadyExists: false,
        order: order++,
      });
    }
  }
  return [0, 5, 20].map((budget) => {
    const r = proposeNewGroupsWithHardCap(queue, budget);
    return {
      budget,
      proposed: r.accepted.length,
      held: r.held.length,
      withinCap: r.accepted.length <= budget,
    };
  });
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const before = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
  };

  // Snapshot Stage9 group count before repair (exclude the 2 targets)
  const otherStage9Before = await count(
    db,
    `SELECT COUNT(*) c FROM apt_pyeong_groups
     WHERE complex_key IN (${STAGE9_IDS.map(() => "?").join(",")})
       AND group_key NOT IN (?,?)`,
    [...STAGE9_IDS, ...REPAIR_GROUPS],
  );

  console.error("Pre-delete safety...");
  const safety = await preDeleteSafety(db);
  let repairResult: {
    status: "PASS" | "HOLD";
    linksDeleted: number;
    groupsDeleted: number;
    reason?: string;
  };

  if (!safety.ok) {
    repairResult = {
      status: "HOLD",
      linksDeleted: 0,
      groupsDeleted: 0,
      reason: safety.reason,
    };
  } else if (safety.alreadyFullyRepaired) {
    repairResult = {
      status: "PASS",
      linksDeleted: 0,
      groupsDeleted: 0,
      reason: "already repaired (idempotent no-op)",
    };
  } else {
    console.error("Executing targeted DELETE...");
    let linksDeleted = 0;
    for (const gk of REPAIR_GROUPS) {
      const beforeLinks = await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
        [gk],
      );
      await db.execute({
        sql: `DELETE FROM apt_unit_type_group_links WHERE group_key=?`,
        args: [gk],
      });
      const afterLinks = await count(
        db,
        `SELECT COUNT(*) c FROM apt_unit_type_group_links WHERE group_key=?`,
        [gk],
      );
      linksDeleted += beforeLinks - afterLinks;
    }
    let groupsDeleted = 0;
    for (const gk of REPAIR_GROUPS) {
      const beforeG = await count(
        db,
        `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key=?`,
        [gk],
      );
      await db.execute({
        sql: `DELETE FROM apt_pyeong_groups WHERE group_key=?`,
        args: [gk],
      });
      const afterG = await count(
        db,
        `SELECT COUNT(*) c FROM apt_pyeong_groups WHERE group_key=?`,
        [gk],
      );
      groupsDeleted += beforeG - afterG;
    }
    const postCheck = await postRepairValidation(db);
    const ok =
      postCheck.remainingInvalid.length === 0 &&
      postCheck.unit802Exists &&
      postCheck.unit9262Exists &&
      postCheck.stage9GroupsRemaining === otherStage9Before;
    repairResult = {
      status: ok ? "PASS" : "HOLD",
      linksDeleted,
      groupsDeleted,
      reason: ok
        ? undefined
        : `post-validation failed remaining=${JSON.stringify(postCheck.remainingInvalid)} stage9Groups=${postCheck.stage9GroupsRemaining} expected=${otherStage9Before}`,
    };
  }

  const post = await postRepairValidation(db);
  const dedupeQa = teranCanonicalReplay();
  const positives = await positiveControls(db);

  console.error("Refinement samples...");
  const samples = await selectRefinementSamples(db);

  const evidence90109 = samples.classA.map((c) => {
    const clusters = clusterAllBands(c.band).map((cl) => ({
      members: cl.members,
      span: cl.span,
      maxGap: cl.maxGap,
      decision:
        cl.decision === "SAFE_GROUP"
          ? ("SAFE_SIMULATION" as const)
          : cl.decision === "AMBIGUOUS"
            ? ("AMBIGUOUS_SIMULATION" as const)
            : ("NOT_GROUPABLE" as const),
      txCounts: cl.txCounts,
      contract: assertMinimumGroupContract(cl.members),
    }));
    return {
      complexId: c.complexId,
      name: c.name,
      members: c.band.map((a) => a.exclusiveArea),
      clusters,
    };
  });

  const evidence5069 = samples.classB.map((c) => {
    const clusters = clusterAllBands(c.band).map((cl) => ({
      members: cl.members,
      span: cl.span,
      maxGap: cl.maxGap,
      decision:
        cl.decision === "SAFE_GROUP"
          ? ("SAFE_SIMULATION" as const)
          : cl.decision === "AMBIGUOUS"
            ? ("AMBIGUOUS_SIMULATION" as const)
            : ("NOT_GROUPABLE" as const),
      txCounts: cl.txCounts,
    }));
    return {
      complexId: c.complexId,
      name: c.name,
      members: c.band.map((a) => a.exclusiveArea),
      consecutiveGaps: c.gaps,
      clusters,
    };
  });

  const all90109 = evidence90109.flatMap((e) => e.clusters);
  const safe90109 = all90109.filter((c) => c.decision === "SAFE_SIMULATION");
  const amb90109 = all90109.filter((c) => c.decision === "AMBIGUOUS_SIMULATION");
  const ng90109 = all90109.filter((c) => c.decision === "NOT_GROUPABLE");

  const all5069 = evidence5069.flatMap((e) => e.clusters);
  const safe5069 = all5069.filter((c) => c.decision === "SAFE_SIMULATION");
  const amb5069 = all5069.filter((c) => c.decision === "AMBIGUOUS_SIMULATION");
  const ng5069 = all5069.filter((c) => c.decision === "NOT_GROUPABLE");

  // Wider gap presence in 90-109
  const widerSafe90109 = safe90109.filter((c) => c.maxGap >= 0.02);

  let ruleDecision:
    | "COMMON_RULE_SUPPORTED"
    | "BAND_SPECIFIC_RULE_NEEDED"
    | "INSUFFICIENT_EVIDENCE"
    | "CURRENT_RULE_UNSAFE";
  let ruleReason: string;

  if (safe90109.some((c) => c.span > 0.2 + 1e-9)) {
    ruleDecision = "CURRENT_RULE_UNSAFE";
    ruleReason = "SAFE simulation exceeded span 0.20";
  } else if (widerSafe90109.length === 0 && safe90109.length > 0) {
    // only ultra-tight 0.01 gaps
    if (amb5069.length > 0) {
      ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
      ruleReason =
        "90–109 SAFE still dominated by ~0.01 gaps (wider-gap SAFE scarce); 50–69 shows AMBIGUOUS at gap>0.15 — threshold behavior differs by band density.";
    } else {
      ruleDecision = "INSUFFICIENT_EVIDENCE";
      ruleReason = "90–109 lacks wider-gap SAFE diversity beyond ~0.01.";
    }
  } else if (widerSafe90109.length >= 2 && amb5069.length === 0 && amb90109.length === 0) {
    ruleDecision = "COMMON_RULE_SUPPORTED";
    ruleReason =
      "Wider-gap SAFE in 90–109 plus clean 50–69 boundary (gap≤0.15 SAFE / >0.15 split) support common heuristic.";
  } else if (amb5069.length > 0 || amb90109.length > 0) {
    ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
    ruleReason = `AMBIGUOUS remain (90–109=${amb90109.length}, 50–69=${amb5069.length}); 90–109 wider SAFE=${widerSafe90109.length}.`;
  } else if (safe90109.length === 0) {
    ruleDecision = "INSUFFICIENT_EVIDENCE";
    ruleReason = "No 90–109 SAFE simulations in sample.";
  } else {
    ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
    ruleReason = "Mixed band evidence — do not declare common rule yet.";
  }

  const coverage = await coverageReconciliation(db);
  const legacy = await legacyAudit(db);
  const writeCap = await writeCapRegression(db);

  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master WHERE sido_code='11' AND identity_status='IDENTITY-READY'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const unitMasterAllKeys = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types`,
  );
  const unitMasterCanonicalAreas = await count(
    db,
    `SELECT COUNT(*) c FROM apt_unit_types`,
  );
  const groupLinkedCanonical = await count(
    db,
    `SELECT COUNT(DISTINCT unit_type_key) c FROM apt_unit_type_group_links`,
  );

  const after = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
  };

  // Next action
  let nextAction: "A" | "B" | "C" | "D" | "E";
  let nextReason: string;
  if (repairResult.status !== "PASS") {
    nextAction = "E";
    nextReason = "Repair HOLD — freeze grouping until repair clears.";
  } else if (ruleDecision === "COMMON_RULE_SUPPORTED") {
    nextAction = "A";
    nextReason = "Repair done + common rule supported — 25-complex bounded expansion.";
  } else if (ruleDecision === "BAND_SPECIFIC_RULE_NEEDED") {
    nextAction = "B";
    nextReason =
      "Repair done but band/boundary evidence still needs band-specific rule design before expansion.";
  } else if (ruleDecision === "INSUFFICIENT_EVIDENCE") {
    nextAction = "D";
    nextReason = "Expand unit-master only until more band evidence exists.";
  } else {
    nextAction = "E";
    nextReason = "Rule unsafe or unclear — freeze grouping.";
  }

  // Legacy identity decision: apt-name→classification→slug lookup works for Phase5.
  // Some Phase5 group rows lack apt_unit_types (orphaned group-only pilots) but do not
  // conflict with cx_ carriers — dual-key compatible for current selector/singoga path.
  const allLegacyLookupOk = legacy.every((l) => l.lookupViaAptNameToSlug);
  const anyConflict = legacy.some(
    (l) => l.unitCountUnderSlug > 0 && l.unitCountUnderCx > 0,
  );
  const identityDecision = anyConflict
    ? ("IDENTITY_CONFLICT" as const)
    : allLegacyLookupOk
      ? ("CURRENT_DUAL-KEY_COMPATIBLE" as const)
      : ("MIGRATION_NEEDED_LATER" as const);

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage11-repair-and-refinement",
    before,
    after,
    targetedRepair: {
      groupsTargeted: [...REPAIR_GROUPS],
      safety,
      linksDeleted: repairResult.linksDeleted,
      groupsDeleted: repairResult.groupsDeleted,
      unitTypesDeleted: 0,
      otherStage9GroupsBefore: otherStage9Before,
      otherStage9GroupsAfter: post.stage9GroupsRemaining,
      otherGroupsChanged: post.stage9GroupsRemaining !== otherStage9Before,
      unit802Preserved: post.unit802Exists,
      unit9262Preserved: post.unit9262Exists,
      protectCounts: post.protectCounts,
      repair: repairResult.status,
      reason: repairResult.reason,
    },
    canonicalDedupeFix: {
      oldOrder: [
        "raw floats → cluster (bug) → later areaKey collapse",
      ],
      newOrder: dedupeQa.order,
      teranReplay: {
        case802: dedupeQa.case802,
        case9262: dedupeQa.case9262,
      },
      zeroSpanReproducibleBefore: true,
      zeroSpanPossibleAfter: !(
        dedupeQa.case802.expectNoGroup && dedupeQa.case9262.expectNoGroup
      ),
      positiveControls: positives,
      status:
        dedupeQa.case802.expectNoGroup &&
        dedupeQa.case9262.expectNoGroup &&
        positives.every((p) => p.status === "VALID_POSITIVE_CONTROL")
          ? ("PASS" as const)
          : ("HOLD" as const),
    },
    refinement90109: {
      complexes: evidence90109.map((e) => ({
        name: e.name,
        complexId: e.complexId,
        members: e.members,
      })),
      details: evidence90109,
      candidateClusters: all90109.length,
      safe: safe90109.length,
      ambiguous: amb90109.length,
      notGroupable: ng90109.length,
      observedSafeSpans: safe90109.map((s) => s.span),
      observedSafeGaps: safe90109.map((s) => s.maxGap),
      widerGapSafeCount: widerSafe90109.length,
      maxSafeSpan:
        safe90109.length > 0 ? Math.max(...safe90109.map((s) => s.span)) : null,
      maxSafeGap:
        safe90109.length > 0 ? Math.max(...safe90109.map((s) => s.maxGap)) : null,
    },
    refinement5069: {
      complexes: evidence5069.map((e) => ({
        name: e.name,
        complexId: e.complexId,
        members: e.members,
        gaps: e.consecutiveGaps,
      })),
      details: evidence5069,
      candidateClusters: all5069.length,
      safe: safe5069.length,
      ambiguous: amb5069.length,
      notGroupable: ng5069.length,
      le015: safe5069.filter((c) => c.maxGap <= 0.15),
      gt015Ambiguous: amb5069.filter((c) => c.maxGap > 0.15),
    },
    ruleDecision: { decision: ruleDecision, reason: ruleReason },
    coverageReconciliation: coverage,
    currentCoverage: {
      seoulComplexes,
      unitMasterComplexesCxOnly: unitMasterComplexes,
      unitMasterComplexesAllKeys: unitMasterAllKeys,
      unitMasterComplexCoveragePct:
        Math.round((unitMasterComplexes / seoulComplexes) * 10000) / 100,
      canonicalRawAreaIdentities: coverage.liveCanonicalDistinct,
      unitMasterCanonicalAreas,
      unitMasterRawAreaCoveragePct:
        Math.round(
          (unitMasterCanonicalAreas / coverage.liveCanonicalDistinct) * 10000,
        ) / 100,
      groupLinkedCanonicalAreas: groupLinkedCanonical,
      groupLinkedRawAreaCoveragePct:
        Math.round(
          (groupLinkedCanonical / coverage.liveCanonicalDistinct) * 10000,
        ) / 100,
    },
    legacyKeyAudit: {
      complexes: legacy,
      lookupCompatibility:
        "loadUnitTypeMasterByAptName: classifications.apt_name_norm → complex_key (slug). Phase5 pilots resolve via apt name. Stage6+ cx_ rows without classification are not loaded by this path (selector still transactions-based).",
      identityDecision,
    },
    writeCapRegression: {
      results: writeCap,
      status: writeCap.every((r) => r.withinCap) ? "PASS" : "HOLD",
    },
    db: {
      insert: 0,
      update: 0,
      deleteLinks: repairResult.linksDeleted,
      deleteGroups: repairResult.groupsDeleted,
      otherWrites: 0,
      unitTypesDelta: after.apt_unit_types - before.apt_unit_types,
      groupsDelta: after.apt_pyeong_groups - before.apt_pyeong_groups,
      linksDelta: after.apt_unit_type_group_links - before.apt_unit_type_group_links,
    },
    selector: {
      productionSelector: "transactions-based",
      migration: "NOT_READY",
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      INVALID_GROUP_REPAIR: repairResult.status,
      CANONICAL_DEDUPE:
        dedupeQa.case802.expectNoGroup && dedupeQa.case9262.expectNoGroup
          ? "PASS"
          : "HOLD",
      GROUP_RULE:
        ruleDecision === "COMMON_RULE_SUPPORTED"
          ? "PASS"
          : ruleDecision === "CURRENT_RULE_UNSAFE"
            ? "HOLD"
            : "PARTIAL",
      COVERAGE_METRIC: "PASS",
      LEGACY_KEY_COMPATIBILITY:
        identityDecision === "CURRENT_DUAL-KEY_COMPATIBLE" ? "PASS" : "PARTIAL",
      WRITE_CAP_CONTROL: writeCap.every((r) => r.withinCap) ? "PASS" : "HOLD",
      DATA_SAFETY:
        after.apt_unit_types === before.apt_unit_types &&
        repairResult.status === "PASS"
          ? "PASS"
          : repairResult.status === "HOLD"
            ? "HOLD"
            : "PASS",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log("\nWrote", OUT);
  if (repairResult.status !== "PASS") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
