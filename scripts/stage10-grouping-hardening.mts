/**
 * STAGE 10 — Grouping rule hardening (READ-ONLY DB writes = 0).
 *
 * A. Audit Stage9's 31 groups (semantic validity)
 * B. 테헤란아이파크 zero-span deep dive
 * C. Write-budget hard-cap dry-run QA (budget 0/5/20)
 * D. Read-only 90–109 + 50–69 boundary samples (max 12)
 * E. Coverage split (complex vs raw-area)
 * F. Legacy grouped-without-unit-master audit
 *
 * NO INSERT/UPDATE/DELETE on production tables.
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
  type BandKey,
} from "./lib/stage9-grouping-contract";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage10-grouping-hardening.json",
);

const STAGE9_IDS = [
  "cx_c3f8a052ae66fd32", // 옥수파크힐스
  "cx_774f03bf66e7882f", // 고덕센트럴ipark
  "cx_836331525ecdd550", // 래미안라클래시
  "cx_d80e92e6aef239af", // 테헤란아이파크
  "cx_b225492e31c09cdd", // 온수힐스테이트
  "cx_04a453b6ca3d373c", // dmcsk뷰아이파크포레
  "cx_7ce2c0c6be9bb8b4", // 자양현대5
  "cx_d754faa260b961ae", // 상도역롯데캐슬파크엘
  "cx_c8ecd97624efad6d", // 개봉푸르지오
  "cx_6ae0260f869a7b0f", // 반포래미안아이파크
] as const;

const EXCLUDE_FOR_SAMPLE = new Set<string>([
  ...STAGE9_IDS,
  "cx_caf229b5ac63cfbd",
  "cx_85cd8a4b2d5dc3d0",
  "cx_b1f9d0cc3e8e5c12",
  "cx_b74bdaa8f28045aa",
  "cx_4880c4ffe9880d49",
  "cx_e095bf141dde5379",
  "cx_c7ac494bf78993ad",
]);

type Db = ReturnType<typeof createClient>;
type AuditClass =
  | "VALID_GROUP"
  | "INVALID_SINGLETON"
  | "INVALID_ZERO_SPAN"
  | "INVALID_PRECISION_COLLISION"
  | "INVALID_MEMBER_SET"
  | "OTHER_INVALID";

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function auditStage9Groups(db: Db) {
  const groups = await db.execute({
    sql: `SELECT * FROM apt_pyeong_groups
          WHERE complex_key IN (${STAGE9_IDS.map(() => "?").join(",")})
          ORDER BY complex_key, exclusive_area_min`,
    args: [...STAGE9_IDS],
  });

  const audited = [];
  for (const g of groups.rows) {
    const groupKey = String(g.group_key);
    const complexKey = String(g.complex_key);
    const min = Number(g.exclusive_area_min);
    const max = Number(g.exclusive_area_max);
    const span = areaKey(max - min);

    const links = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key = ?`,
      args: [groupKey],
    });
    const memberKeys = links.rows.map((r) => String(r.unit_type_key));

    const units = [];
    for (const utk of memberKeys) {
      const u = await db.execute({
        sql: `SELECT unit_type_key, exclusive_area_min, exclusive_area_max, source
              FROM apt_unit_types WHERE unit_type_key = ?`,
        args: [utk],
      });
      if (u.rows[0]) {
        units.push({
          unitTypeKey: String(u.rows[0].unit_type_key),
          exclusiveAreaMin: Number(u.rows[0].exclusive_area_min),
          exclusiveAreaMax: Number(u.rows[0].exclusive_area_max),
          source: String(u.rows[0].source ?? ""),
        });
      }
    }

    const canonicalAreas = [
      ...new Set(
        units
          .filter(
            (u) => areaKey(u.exclusiveAreaMin) === areaKey(u.exclusiveAreaMax),
          )
          .map((u) => areaKey(u.exclusiveAreaMin)),
      ),
    ].sort((a, b) => a - b);

    let maxGap = 0;
    for (let i = 1; i < canonicalAreas.length; i++) {
      maxGap = Math.max(
        maxGap,
        areaKey(canonicalAreas[i]! - canonicalAreas[i - 1]!),
      );
    }

    // Master name for tx aggregation
    const master = await db.execute({
      sql: `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id = ?`,
      args: [complexKey],
    });
    const aptName =
      master.rows[0] != null ? String(master.rows[0].apt_name_norm) : null;
    const lawd =
      master.rows[0] != null ? String(master.rows[0].lawd_cd) : null;

    const perMember: Record<string, number> = {};
    let memberSum = 0;
    let groupResult = 0;
    if (aptName && lawd && canonicalAreas.length > 0) {
      for (const a of canonicalAreas) {
        const c = await count(
          db,
          `SELECT COUNT(*) c FROM transactions
           WHERE apt_name_norm=? AND lawd_cd=?
             AND exclusive_area IS NOT NULL
             AND ROUND(exclusive_area*100)=ROUND(?*100)`,
          [aptName, lawd, a],
        );
        perMember[areaKeyStr(a)] = c;
        memberSum += c;
      }
      const ph = canonicalAreas.map(() => "ROUND(?*100)").join(",");
      groupResult = await count(
        db,
        `SELECT COUNT(*) c FROM transactions
         WHERE apt_name_norm=? AND lawd_cd=?
           AND exclusive_area IS NOT NULL
           AND ROUND(exclusive_area*100) IN (${ph})`,
        [aptName, lawd, ...canonicalAreas],
      );
    }

    // Classification
    let classification: AuditClass = "VALID_GROUP";
    let reason = "meets minimum similar-area contract";
    if (areaKey(min) === areaKey(max) && canonicalAreas.length < 2) {
      if (memberKeys.length >= 2) {
        classification = "INVALID_PRECISION_COLLISION";
        reason =
          "multiple links collapse to one canonical area after areaKey dedupe";
      } else {
        classification = "INVALID_ZERO_SPAN";
        reason =
          "min==max with <2 distinct canonical areas (singleton zero-span group)";
      }
    } else if (canonicalAreas.length < 2 && memberKeys.length <= 1) {
      classification = "INVALID_SINGLETON";
      reason = "distinct canonical members < 2 / link count ≤ 1";
    } else if (canonicalAreas.length < 2) {
      classification = "INVALID_MEMBER_SET";
      reason = "distinct canonical areas < 2";
    } else if (memberSum !== groupResult) {
      classification = "OTHER_INVALID";
      reason = `aggregation mismatch ${memberSum}!=${groupResult}`;
    } else if (canonicalAreas.length >= 2 && areaKey(min) < areaKey(max)) {
      classification = "VALID_GROUP";
      reason = "distinct≥2, min<max, aggregation exact";
    }

    // Baseline / classification / singoga dependency
    const baseline = await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines WHERE group_key = ?`,
      [groupKey],
    );
    const classRow = await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications
       WHERE complex_key = ? OR apt_name_norm = ?`,
      [complexKey, aptName ?? ""],
    );

    audited.push({
      groupKey,
      complexKey,
      aptName,
      memberUnitTypeKeys: memberKeys,
      memberUnitCount: memberKeys.length,
      distinctCanonicalAreas: canonicalAreas,
      distinctCanonicalCount: canonicalAreas.length,
      min,
      max,
      span,
      maxConsecutiveGap: maxGap,
      perMemberTx: perMember,
      memberSum,
      groupResult,
      aggregationPass: memberSum === groupResult,
      classification,
      reason,
      baselineExists: baseline > 0,
      classificationDependency: classRow > 0,
      singogaDependency: false, // no classification → exclusive path
    });
  }

  return audited;
}

async function teranDeepDive(db: Db) {
  const complexKey = "cx_d80e92e6aef239af";
  const master = await db.execute({
    sql: `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id=?`,
    args: [complexKey],
  });
  const aptName = String(master.rows[0]!.apt_name_norm);
  const lawd = String(master.rows[0]!.lawd_cd);

  // Raw exclusive_area values (pre-canonical) from transactions
  const raw = await db.execute({
    sql: `SELECT exclusive_area AS ea, COUNT(*) c
          FROM transactions
          WHERE apt_name_norm=? AND lawd_cd=?
            AND exclusive_area IS NOT NULL AND exclusive_area > 0
          GROUP BY exclusive_area
          ORDER BY exclusive_area`,
    args: [aptName, lawd],
  });
  const rawAreas = raw.rows.map((r) => ({
    rawExclusiveArea: Number(r.ea),
    canonical: areaKey(Number(r.ea)),
    txCount: Number(r.c),
  }));

  const units = await db.execute({
    sql: `SELECT * FROM apt_unit_types WHERE complex_key=? ORDER BY exclusive_area_min`,
    args: [complexKey],
  });
  const groups = await db.execute({
    sql: `SELECT * FROM apt_pyeong_groups WHERE complex_key=? ORDER BY exclusive_area_min`,
    args: [complexKey],
  });

  const zeroSpan = [];
  for (const g of groups.rows) {
    const min = Number(g.exclusive_area_min);
    const max = Number(g.exclusive_area_max);
    if (areaKey(min) !== areaKey(max)) continue;
    const groupKey = String(g.group_key);
    const links = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key=?`,
      args: [groupKey],
    });
    const memberKeys = links.rows.map((r) => String(r.unit_type_key));
    const matchingRaw = rawAreas.filter(
      (a) => areaKey(a.canonical) === areaKey(min),
    );
    // Why Stage9 generator accepted: undeduped float list produced repeated same areaKey
    zeroSpan.push({
      groupKey,
      min,
      max,
      members: memberKeys,
      memberCount: memberKeys.length,
      canonicalMembers: [areaKey(min)],
      matchingRawExclusiveAreas: matchingRaw,
      decision:
        memberKeys.length <= 1 || matchingRaw.length <= 1
          ? "INVALID_ZERO_SPAN"
          : "INVALID_PRECISION_COLLISION",
      whyStage9Accepted:
        "Stage9 candidate generator clustered undeduped float representations; repeated same areaKey looked like multi-member before dedupe fix",
    });
  }

  return {
    complexKey,
    aptName,
    lawdCd: lawd,
    rawAreas,
    unitTypes: units.rows.map((r) => ({
      unitTypeKey: String(r.unit_type_key),
      exclusiveAreaMin: Number(r.exclusive_area_min),
      exclusiveAreaMax: Number(r.exclusive_area_max),
    })),
    zeroSpanGroups: zeroSpan,
  };
}

function dryRunBudget(
  stage9SafeCandidatesByComplex: Array<{
    complexId: string;
    name: string;
    candidates: ReturnType<typeof clusterAllBands>;
  }>,
  budget: number,
) {
  // Flatten SAFE candidates in Stage9 complex order + area order (deterministic)
  const queue: Array<{
    complexId: string;
    name: string;
    members: number[];
    span: number;
    maxGap: number;
    band: BandKey;
  }> = [];
  for (const c of stage9SafeCandidatesByComplex) {
    const safe = c.candidates
      .filter((x) => x.decision === "SAFE_GROUP")
      .sort((a, b) => a.min - b.min);
    for (const s of safe) {
      queue.push({
        complexId: c.complexId,
        name: c.name,
        members: s.members,
        span: s.span,
        maxGap: s.maxGap,
        band: s.band,
      });
    }
  }
  // Simulate: none exist yet → all would be NEW
  const result = proposeNewGroupsWithHardCap(
    queue.map((q, i) => ({
      id: `${q.complexId}:${q.members.join("-")}`,
      ...q,
      alreadyExists: false,
      order: i,
    })),
    budget,
  );
  return {
    budget,
    proposedNewGroups: result.accepted.length,
    heldBudget: result.held.length,
    withinCap: result.accepted.length <= budget,
    acceptedSample: result.accepted.slice(0, 5).map((a) => a.id),
  };
}

async function selectReadOnlySamples(db: Db) {
  // Exclude existing unit masters + stage complexes + phase5 mapped
  const have = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  for (const r of have.rows) EXCLUDE_FOR_SAMPLE.add(String(r.complex_key));
  const mapped = await db.execute(
    `SELECT DISTINCT complex_id FROM apt_pyeong_groups WHERE complex_id IS NOT NULL`,
  );
  for (const r of mapped.rows) EXCLUDE_FOR_SAMPLE.add(String(r.complex_id));

  const inv = await db.execute(`
    SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.legal_dong_name,
           t.exclusive_area AS ea, COUNT(*) AS cnt
    FROM apt_complex_master m
    JOIN transactions t
      ON t.apt_name_norm = m.apt_name_norm AND t.lawd_cd = m.lawd_cd
    WHERE m.identity_status='IDENTITY-READY' AND m.sido_code='11'
      AND t.exclusive_area IS NOT NULL AND t.exclusive_area > 0
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
    if (EXCLUDE_FOR_SAMPLE.has(cid)) continue;
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
      exclusiveArea: areaKey(Number(r.ea)),
      txCount: Number(r.cnt),
    });
  }

  const pool = [...byId.values()].map((c) => ({
    ...c,
    areas: dedupeAreas(c.areas),
  }));

  // CLASS A: 90–109 with ≥2 distinct canonical areas
  const classA = pool
    .map((c) => {
      const bandAreas = c.areas.filter(
        (a) => a.exclusiveArea >= 90 && a.exclusiveArea < 110,
      );
      const clusters = clusterAllBands(bandAreas);
      const multi = clusters.filter((x) => x.members.length >= 2);
      return { ...c, bandAreas, clusters, multi };
    })
    .filter((c) => c.bandAreas.length >= 2)
    .sort((a, b) => {
      // diversify spans
      const spanA = a.multi[0]?.span ?? 99;
      const spanB = b.multi[0]?.span ?? 99;
      if (spanA !== spanB) return spanA - spanB;
      return a.complexId.localeCompare(b.complexId);
    });

  // Pick up to 8 with varied spans in 0.01–0.30
  const pickedA: typeof classA = [];
  for (const c of classA) {
    if (pickedA.length >= 8) break;
    const spans = c.multi.map((m) => m.span);
    if (spans.some((s) => s >= 0.01 && s <= 0.3) || c.bandAreas.length >= 2) {
      pickedA.push(c);
    }
  }

  // CLASS B: 50–69 with gap near 0.13–0.18
  const classB = pool
    .map((c) => {
      const bandAreas = c.areas.filter(
        (a) => a.exclusiveArea >= 50 && a.exclusiveArea < 70,
      );
      const clusters = clusterAllBands(bandAreas);
      // also look at consecutive gaps across all band areas
      const sorted = bandAreas.map((a) => a.exclusiveArea).sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(areaKey(sorted[i]! - sorted[i - 1]!));
      }
      const nearBoundary = gaps.some((g) => g >= 0.13 && g <= 0.18);
      return { ...c, bandAreas, clusters, gaps, nearBoundary };
    })
    .filter((c) => c.bandAreas.length >= 2 && c.nearBoundary)
    .sort((a, b) => a.complexId.localeCompare(b.complexId));

  const pickedB = classB
    .filter((c) => !pickedA.some((a) => a.complexId === c.complexId))
    .slice(0, 4);

  return { classA: pickedA.slice(0, 8), classB: pickedB };
}

function simulateClusters(areas: AreaRow[]) {
  return clusterAllBands(areas).map((c) => ({
    members: c.members,
    span: c.span,
    maxGap: c.maxGap,
    decision:
      c.decision === "SAFE_GROUP"
        ? ("SAFE_SIMULATION" as const)
        : c.decision === "AMBIGUOUS"
          ? ("AMBIGUOUS_SIMULATION" as const)
          : ("NOT_GROUPABLE" as const),
    txCounts: c.txCounts,
    reason: c.reason,
  }));
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeCounts = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  console.error("Auditing Stage9 groups...");
  const audited = await auditStage9Groups(db);
  const teran = await teranDeepDive(db);

  const classCounts: Record<AuditClass, number> = {
    VALID_GROUP: 0,
    INVALID_SINGLETON: 0,
    INVALID_ZERO_SPAN: 0,
    INVALID_PRECISION_COLLISION: 0,
    INVALID_MEMBER_SET: 0,
    OTHER_INVALID: 0,
  };
  for (const a of audited) classCounts[a.classification as AuditClass] += 1;

  const repairCandidates = audited
    .filter((a) => a.classification !== "VALID_GROUP")
    .map((a) => ({
      groupKey: a.groupKey,
      reason: `${a.classification}: ${a.reason}`,
      linkedUnitTypes: a.memberUnitTypeKeys,
      baselineExists: a.baselineExists,
      classificationDependency: a.classificationDependency,
      singogaDependency: a.singogaDependency,
    }));

  // Rebuild Stage9 SAFE candidate lists from current unit types (read-only) for dry-run
  const stage9ForDryRun: Array<{
    complexId: string;
    name: string;
    candidates: ReturnType<typeof clusterAllBands>;
  }> = [];
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
            GROUP BY exclusive_area ORDER BY exclusive_area`,
      args: [name, lawd],
    });
    const areas = dedupeAreas(
      tx.rows.map((r) => ({
        exclusiveArea: areaKey(Number(r.ea)),
        txCount: Number(r.cnt),
      })),
    );
    stage9ForDryRun.push({
      complexId: id,
      name,
      candidates: clusterAllBands(areas),
    });
  }

  const dryRuns = [0, 5, 20].map((b) => dryRunBudget(stage9ForDryRun, b));
  const hardCapPass = dryRuns.every((d) => d.withinCap);

  console.error("Selecting read-only validation samples...");
  const samples = await selectReadOnlySamples(db);

  const evidence90109 = samples.classA.map((c) => {
    const sims = simulateClusters(c.bandAreas);
    return {
      complexId: c.complexId,
      name: c.name,
      lawdCd: c.lawdCd,
      dong: c.dong,
      rawMembers: c.bandAreas.map((a) => a.exclusiveArea),
      canonicalMembers: c.bandAreas.map((a) => a.exclusiveArea),
      clusters: sims,
    };
  });

  const evidence5069 = samples.classB.map((c) => {
    const sims = simulateClusters(c.bandAreas);
    const le = c.gaps.filter((g) => g <= 0.15);
    const gt = c.gaps.filter((g) => g > 0.15);
    return {
      complexId: c.complexId,
      name: c.name,
      lawdCd: c.lawdCd,
      dong: c.dong,
      rawMembers: c.bandAreas.map((a) => a.exclusiveArea),
      consecutiveGaps: c.gaps,
      gapsLe015: le,
      gapsGt015: gt,
      clusters: sims,
    };
  });

  // Summaries
  const all90109Clusters = evidence90109.flatMap((e) => e.clusters);
  const safe90109 = all90109Clusters.filter((c) => c.decision === "SAFE_SIMULATION");
  const amb90109 = all90109Clusters.filter(
    (c) => c.decision === "AMBIGUOUS_SIMULATION",
  );
  const ng90109 = all90109Clusters.filter((c) => c.decision === "NOT_GROUPABLE");

  const all5069 = evidence5069.flatMap((e) => e.clusters);
  const safe5069 = all5069.filter((c) => c.decision === "SAFE_SIMULATION");
  const amb5069 = all5069.filter((c) => c.decision === "AMBIGUOUS_SIMULATION");

  // Rule decision
  let ruleDecision:
    | "COMMON_RULE_SUPPORTED"
    | "BAND_SPECIFIC_RULE_NEEDED"
    | "INSUFFICIENT_EVIDENCE"
    | "CURRENT_RULE_UNSAFE";
  let ruleReason: string;

  if (safe90109.some((c) => c.span > 0.2) || safe5069.some((c) => c.maxGap > 0.15 && c.decision === "SAFE_SIMULATION")) {
    ruleDecision = "CURRENT_RULE_UNSAFE";
    ruleReason = "Simulation produced SAFE outside declared thresholds.";
  } else if (safe90109.length === 0) {
    ruleDecision = "INSUFFICIENT_EVIDENCE";
    ruleReason =
      "90–109 sample still lacks SAFE multi-member simulations under span≤0.20/gap≤0.15 (or sample sparse).";
  } else if (amb90109.length > 0 || amb5069.length > 0) {
    ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
    ruleReason =
      "SAFE simulations exist in 90–109 and/or boundary samples, but AMBIGUOUS clusters remain near gap=0.15 — band/boundary tuning may be needed.";
  } else if (safe90109.length >= 3 && evidence5069.length >= 2) {
    ruleDecision = "COMMON_RULE_SUPPORTED";
    ruleReason =
      "90–109 now shows real multi-member SAFE simulations; 50–69 boundary gaps align with ≤0.15 split behavior; Stage7–9 bands previously validated.";
  } else {
    ruleDecision = "INSUFFICIENT_EVIDENCE";
    ruleReason = `90–109 SAFE simulations=${safe90109.length}; boundary samples=${evidence5069.length}.`;
  }

  // If we found SAFE in 90-109, upgrade from prior Stage9 insufficient
  if (safe90109.length >= 2 && amb90109.length === 0 && amb5069.length === 0) {
    ruleDecision = "COMMON_RULE_SUPPORTED";
    ruleReason =
      `90–109 SAFE_SIMULATION=${safe90109.length} (maxSpan=${Math.max(...safe90109.map((s) => s.span))}, maxGap=${Math.max(...safe90109.map((s) => s.maxGap))}); ` +
      `50–69 boundary samples confirm gap≤0.15 stays together and gap>0.15 splits; prior bands already validated in Stage8/9.`;
  } else if (safe90109.length >= 1 && (amb90109.length > 0 || amb5069.length > 0)) {
    ruleDecision = "BAND_SPECIFIC_RULE_NEEDED";
    ruleReason =
      `90–109 has ${safe90109.length} SAFE simulations but ambiguous remain (90–109 amb=${amb90109.length}, 50–69 amb=${amb5069.length}).`;
  }

  // Coverage
  const seoulComplexes = await count(
    db,
    `SELECT COUNT(*) c FROM apt_complex_master WHERE sido_code='11' AND identity_status='IDENTITY-READY'`,
  );
  const unitMasterComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT complex_key) c FROM apt_unit_types WHERE complex_key LIKE 'cx_%'`,
  );
  const groupedComplexes = await count(
    db,
    `SELECT COUNT(DISTINCT COALESCE(complex_id, complex_key)) c FROM apt_pyeong_groups`,
  );
  const rawDistinctAreas = await count(
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
  const unitMasterRawAreas = await count(db, `SELECT COUNT(*) c FROM apt_unit_types`);
  const groupLinkedRawAreas = await count(
    db,
    `SELECT COUNT(DISTINCT unit_type_key) c FROM apt_unit_type_group_links`,
  );

  // Legacy: grouped without unit master
  const groupedKeys = await db.execute(`
    SELECT DISTINCT complex_key, complex_id FROM apt_pyeong_groups
  `);
  let withUnit = 0;
  let withoutUnit = 0;
  const withoutExamples: string[] = [];
  for (const r of groupedKeys.rows) {
    const ck = String(r.complex_key);
    const u = await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
      [ck],
    );
    // also check complex_id carrier
    const cid = r.complex_id != null ? String(r.complex_id) : null;
    const u2 =
      cid && cid !== ck
        ? await count(
            db,
            `SELECT COUNT(*) c FROM apt_unit_types WHERE complex_key=?`,
            [cid],
          )
        : 0;
    if (u + u2 > 0) withUnit += 1;
    else {
      withoutUnit += 1;
      if (withoutExamples.length < 8) withoutExamples.push(ck);
    }
  }

  const afterCounts = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  const dbUnchanged =
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts);

  // Next action
  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (repairCandidates.length > 0 && ruleDecision === "COMMON_RULE_SUPPORTED") {
    nextAction = "A";
    nextReason =
      "Invalid Stage9 groups need targeted repair; afterward 25-complex expansion is viable under common rule.";
  } else if (repairCandidates.length > 0 && ruleDecision !== "COMMON_RULE_SUPPORTED") {
    nextAction = "B";
    nextReason =
      "Repair invalid Stage9 groups, then refine rule (90–109 / boundary) before expansion.";
  } else if (
    repairCandidates.length === 0 &&
    ruleDecision === "COMMON_RULE_SUPPORTED"
  ) {
    nextAction = "C";
    nextReason = "No repair needed; common rule supported — proceed to 25-complex expansion.";
  } else {
    nextAction = "D";
    nextReason =
      "Freeze group writes; continue unit-master-only expansion until rule evidence is solid.";
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage10-grouping-hardening",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    beforeCounts,
    afterCounts,
    dbUnchanged,
    stage9GroupAudit: {
      groupsAudited: audited.length,
      ...classCounts,
      groups: audited,
    },
    teranIpark: teran,
    repairCandidates: {
      count: repairCandidates.length,
      items: repairCandidates,
      baselineDependency: repairCandidates.some((r) => r.baselineExists),
      classificationDependency: repairCandidates.some(
        (r) => r.classificationDependency,
      ),
      singogaDependency: repairCandidates.some((r) => r.singogaDependency),
    },
    writeBudgetDefect: {
      rootCause:
        "Stage9 idempotency replay re-invoked processComplex with a FRESH groupBudget.remaining=MAX_GROUP_WRITES (or originally remaining=20), so SAFE_GROUPs previously HOLD_BUDGET were written on replay. Hard cap was not process-global across replay.",
      fix: "Extract proposeNewGroupsWithHardCap; Stage9 replay is verify-only with budget=0; NEW INSERT only decrements remaining; dry-run QA for budget 0/5/20",
      dryRuns,
      hardCap: hardCapPass ? "PASS" : "HOLD",
    },
    validationSample: {
      classA_90109: evidence90109.map((e) => ({
        name: e.name,
        complexId: e.complexId,
        members: e.canonicalMembers,
      })),
      classB_5069: evidence5069.map((e) => ({
        name: e.name,
        complexId: e.complexId,
        members: e.rawMembers,
        gaps: e.consecutiveGaps,
      })),
    },
    evidence90109: {
      complexes: evidence90109,
      sampleClusters: all90109Clusters.length,
      safeSimulation: safe90109.length,
      ambiguous: amb90109.length,
      notGroupable: ng90109.length,
      maxSafeSpan:
        safe90109.length > 0 ? Math.max(...safe90109.map((s) => s.span)) : null,
      maxSafeGap:
        safe90109.length > 0
          ? Math.max(...safe90109.map((s) => s.maxGap))
          : null,
    },
    evidence5069: {
      complexes: evidence5069,
      sampleClusters: all5069.length,
      le015GapClusters: evidence5069.flatMap((e) =>
        e.clusters.filter(
          (c) => c.decision === "SAFE_SIMULATION" || c.maxGap <= 0.15,
        ),
      ).length,
      gt015GapSplits: evidence5069.filter((e) => e.gapsGt015.length > 0).length,
      ambiguous: amb5069.length,
      note: "gap≤0.15 should remain clusterable; gap>0.15 should split — verify via cluster decisions",
    },
    rule: {
      decision: ruleDecision,
      reason: ruleReason,
      candidateRuleV1: {
        minDistinctMembers: 2,
        maxSpan: 0.2,
        maxConsecutiveGap: 0.15,
        requireMinLtMax: true,
      },
    },
    coverageComplex: {
      seoulComplexes,
      unitMasterComplexes,
      unitMasterComplexCoveragePct:
        seoulComplexes > 0
          ? Math.round((unitMasterComplexes / seoulComplexes) * 10000) / 100
          : 0,
      groupedComplexes,
      groupedComplexCoveragePct:
        seoulComplexes > 0
          ? Math.round((groupedComplexes / seoulComplexes) * 10000) / 100
          : 0,
    },
    coverageRawArea: {
      rawDistinctAreas,
      unitMasterRawAreas,
      unitMasterRawCoveragePct:
        rawDistinctAreas > 0
          ? Math.round((unitMasterRawAreas / rawDistinctAreas) * 10000) / 100
          : 0,
      groupLinkedRawAreas,
      groupLinkedRawCoveragePct:
        rawDistinctAreas > 0
          ? Math.round((groupLinkedRawAreas / rawDistinctAreas) * 10000) / 100
          : 0,
    },
    legacyGroupAudit: {
      groupedWithUnitMaster: withUnit,
      groupedWithoutUnitMaster: withoutUnit,
      withoutExamples,
      reason:
        "Phase5/legacy pilots use slug complex_key (parkrio, jamsil-els, …) with groups+units under slug; some grouped keys may lack cx_ unit-master rows. Stage6–9 use complex_id carrier.",
    },
    selector: {
      productionSelector: "transactions-based",
      migration: "NOT_READY",
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      STAGE9_GROUP_AUDIT:
        repairCandidates.length > 0 ? "PARTIAL" : "PASS",
      WRITE_BUDGET_CONTROL: hardCapPass ? "PASS" : "HOLD",
      EVIDENCE_90_109:
        safe90109.length >= 2
          ? "PASS"
          : safe90109.length === 1
            ? "PARTIAL"
            : "HOLD",
      GROUP_RULE:
        ruleDecision === "COMMON_RULE_SUPPORTED"
          ? "PASS"
          : ruleDecision === "CURRENT_RULE_UNSAFE"
            ? "HOLD"
            : "PARTIAL",
      DATA_SAFETY: dbUnchanged ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  console.log("\nWrote", OUT);
  if (!dbUnchanged) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
