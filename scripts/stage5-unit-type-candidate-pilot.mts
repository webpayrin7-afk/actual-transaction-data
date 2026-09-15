/**
 * STAGE 5 — Unit-type candidate pilot (read-only DB writes = 0 for unit/group tables).
 *
 * For 리센츠 / 트리지움:
 * - inventory distinct exclusive areas from transactions (RAW preserved)
 * - emit CANDIDATE unit types
 * - emit CANDIDATE similar-area groups (derived layer only; no merge of raw)
 *
 * Does NOT write apt_unit_types / apt_unit_type_group_links / apt_pyeong_groups.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT = join(process.cwd(), "data/poc/unit-area/unit-type-candidate-pilot.json");
const PYEONG = 3.305785;

const TARGETS = [
  {
    name: "리센츠",
    complexId: "cx_caf229b5ac63cfbd",
    aptNameNorm: "리센츠",
    lawdCd: "11710",
  },
  {
    name: "트리지움",
    complexId: "cx_85cd8a4b2d5dc3d0",
    aptNameNorm: "트리지움",
    lawdCd: "11710",
  },
] as const;

type AreaInv = {
  exclusiveArea: number;
  txCount: number;
  latestYearMonth: string | null;
  approxPyeongDisplay: number;
};

/** Suggest similar-area candidate clusters without collapsing raw identities. */
function candidateGroups(areas: AreaInv[]): Array<{
  status: "CANDIDATE";
  labelHint: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  memberAreas: number[];
  rationale: string;
}> {
  const sorted = [...areas].map((a) => a.exclusiveArea).sort((a, b) => a - b);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const ea of sorted) {
    if (cur.length === 0) {
      cur = [ea];
      continue;
    }
    const lo = cur[0]!;
    // Tight cluster only: within 0.2㎡ of group min — CANDIDATE heuristic, not policy.
    if (ea - lo <= 0.2) cur.push(ea);
    else {
      groups.push(cur);
      cur = [ea];
    }
  }
  if (cur.length) groups.push(cur);

  return groups
    .filter((g) => g.length >= 2)
    .map((g) => {
      const min = g[0]!;
      const max = g[g.length - 1]!;
      const mid = (min + max) / 2;
      const pyeong = Math.round(mid / PYEONG);
      return {
        status: "CANDIDATE" as const,
        labelHint: `${pyeong}평대`,
        exclusiveAreaMin: min,
        exclusiveAreaMax: max,
        memberAreas: g,
        rationale:
          "CANDIDATE only: exclusive areas within ≤0.2㎡ span. Does not replace raw unit types. Not verified policy.",
      };
    });
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const complexes = [];
  for (const t of TARGETS) {
    const tx = await db.execute({
      sql: `
        SELECT exclusive_area AS ea, COUNT(*) AS cnt, MAX(year_month) AS latest
        FROM transactions
        WHERE apt_name_norm = ? AND lawd_cd = ?
          AND exclusive_area IS NOT NULL AND exclusive_area > 0
        GROUP BY exclusive_area
        ORDER BY exclusive_area
      `,
      args: [t.aptNameNorm, t.lawdCd],
    });

    const areas: AreaInv[] = tx.rows.map((r) => {
      const ea = Number(r.ea);
      return {
        exclusiveArea: ea,
        txCount: Number(r.cnt),
        latestYearMonth: r.latest != null ? String(r.latest) : null,
        approxPyeongDisplay: Math.round((ea / PYEONG) * 100) / 100,
      };
    });

    // Existing unit master / group coverage (read-only)
    const units = await db.execute({
      sql: `SELECT COUNT(*) c FROM apt_unit_types ut
            JOIN apt_pyeong_groups g ON g.complex_key = ut.complex_key
            WHERE g.complex_id = ?`,
      args: [t.complexId],
    });
    const unitCount = Number(units.rows[0]!.c);

    const unitCandidates = areas.map((a, idx) => ({
      status: "CANDIDATE" as const,
      provisionalKey: `${t.complexId}:ex${a.exclusiveArea}`,
      exclusiveArea: a.exclusiveArea,
      exclusiveAreaMin: a.exclusiveArea,
      exclusiveAreaMax: a.exclusiveArea,
      approxPyeongDisplay: a.approxPyeongDisplay,
      txCount: a.txCount,
      sortOrder: idx,
      note: "RAW exclusive area identity — must survive any future grouping layer",
    }));

    const similarCandidates = candidateGroups(areas);

    complexes.push({
      complexId: t.complexId,
      complexName: t.name,
      lawdCd: t.lawdCd,
      existingUnitMasterRows: unitCount,
      rawAreaCount: areas.length,
      rawAreas: areas,
      unitTypeCandidates: unitCandidates,
      similarAreaGroupCandidates: similarCandidates,
      readiness: {
        allRawAreasDisplayableFromTx: areas.length > 0,
        unitMasterPresent: unitCount > 0,
        groupingLayerPresent: false,
        recommendedNext:
          unitCount === 0
            ? "Persist CANDIDATE unit types as apt_unit_types (1:1 with raw exclusive_area) before any similar-area grouping"
            : "Audit existing unit master vs raw areas",
      },
    });
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    stage: "stage5-unit-type-candidate-pilot",
    scope: "리센츠 + 트리지움 only",
    principles: {
      rawUnitTypeMustSurvive: true,
      similarAreaGroupIsDerivedLayer: true,
      autoGroupSeoulWide: false,
      dbWritesToUnitTables: 0,
      candidatePolicyNote:
        "≤0.2㎡ span is a CANDIDATE heuristic only — not approved merge policy",
    },
    complexes,
    decision: {
      UNIT_TYPE_CANDIDATE_PILOT: "PASS",
      SIMILAR_AREA_GROUP_CANDIDATES: "PASS_AS_CANDIDATE_ONLY",
      DB_SAFETY: "PASS",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        complexes: complexes.map((c) => ({
          name: c.complexName,
          rawAreaCount: c.rawAreaCount,
          unitCandidates: c.unitTypeCandidates.length,
          similarCandidates: c.similarAreaGroupCandidates.length,
          similar: c.similarAreaGroupCandidates,
          areas: c.rawAreas.map((a) => a.exclusiveArea),
        })),
        decision: artifact.decision,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
