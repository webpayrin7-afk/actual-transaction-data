#!/usr/bin/env npx tsx
/**
 * PROFILE phase 2 — close coverage only from evidence already on hand.
 *
 * Rejects building-row and household-sum rules that fail known-positive parity.
 * Applies FAR/BCR only when every recap row on an exact parcel carries the same
 * valid value (BUILDING_HUB_DUPLICATE_COLLAPSE). NULL_SAFE_FILL only.
 *
 *   npx tsx scripts/profile-seoul-hero-phase2.mts
 *   npx tsx scripts/profile-seoul-hero-phase2.mts --apply
 */
import { createClient, type Client } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "data/poc/profile-hero");
const APPLY = process.argv.includes("--apply");
mkdirSync(OUT, { recursive: true });

type RecapRow = {
  name: string;
  complex_id: string;
  n: number;
  far: Array<number | null>;
  bcr: Array<number | null>;
  hh: Array<number | null>;
  bld: Array<number | null>;
  park: Array<number | null>;
  ap: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function sameValid(values: Array<number | null>, max: number): number | null {
  if (!values.length) return null;
  const nums = values.map((v) => (v == null ? null : Number(v)));
  if (nums.some((v) => v == null || !Number.isFinite(v))) return null;
  const first = nums[0] as number;
  if (nums.some((v) => v !== first)) return null;
  if (!(first > 0 && first <= max)) return null;
  return first;
}

async function coverage(db: Client) {
  const cov = await db.execute(`
    SELECT COUNT(*) total,
      SUM(p.complex_id IS NOT NULL) profile_rows,
      SUM(p.household_count IS NOT NULL) household_count,
      SUM(p.building_count IS NOT NULL) building_count,
      SUM(p.approval_date IS NOT NULL) approval_date,
      SUM(p.max_floor IS NOT NULL) max_floor,
      SUM(p.parking_per_household IS NOT NULL) parking_per_household,
      SUM(p.far_ratio IS NOT NULL) far_ratio,
      SUM(p.bcr_ratio IS NOT NULL) bcr_ratio,
      SUM(p.heating_type IS NOT NULL) heating_type
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const rows = await db.execute(`
    SELECT p.household_count hh, p.building_count bd, p.approval_date ap, p.max_floor fl,
           p.parking_per_household pk, p.far_ratio far, p.bcr_ratio bcr, p.heating_type ht
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const b = { FULL_HERO: 0, GOOD_HERO: 0, PARTIAL_HERO: 0, NO_PROFILE: 0 };
  for (const r of rows.rows) {
    const flags = [r.hh, r.bd, r.ap, r.fl, r.pk, r.far, r.bcr, r.ht].map((v) => v != null);
    const n = flags.filter(Boolean).length;
    if (n === 0) b.NO_PROFILE++;
    else if (n === 8) b.FULL_HERO++;
    else if (r.hh != null && r.bd != null && r.ap != null && r.fl != null) {
      const opt = [r.pk, r.far, r.bcr, r.ht].filter((v) => v != null).length;
      if (opt >= 2) b.GOOD_HERO++;
      else b.PARTIAL_HERO++;
    } else b.PARTIAL_HERO++;
  }
  return { coverage: cov.rows[0], buckets: b };
}

async function validate(db: Client) {
  const bld = await db.execute(`
    WITH agg AS (
      SELECT complex_id,
        SUM(CASE WHEN residential_flag=1 AND main_atch_type='주건축물' AND status='EXACT' THEN 1 ELSE 0 END) res_n,
        SUM(CASE WHEN residential_flag=1 AND main_atch_type='주건축물' AND status='EXACT' THEN COALESCE(household_count,0) ELSE 0 END) hh_sum,
        MAX(CASE WHEN residential_flag=1 AND main_atch_type='주건축물' AND status='EXACT' THEN floor_count END) max_fl
      FROM complex_buildings GROUP BY 1
    )
    SELECT
      SUM(p.building_count IS NOT NULL) bld_known,
      SUM(p.building_count IS NOT NULL AND p.building_count = a.res_n) bld_exact,
      SUM(p.building_count IS NOT NULL AND ABS(p.building_count - a.res_n)=1) bld_off1,
      SUM(p.building_count IS NOT NULL AND a.res_n IS NOT NULL AND ABS(p.building_count - a.res_n)>1) bld_material,
      SUM(p.household_count IS NOT NULL) hh_known,
      SUM(p.household_count IS NOT NULL AND p.household_count = a.hh_sum) hh_exact,
      SUM(p.household_count IS NOT NULL AND a.hh_sum>0 AND p.household_count != a.hh_sum AND ABS(p.household_count-a.hh_sum)*1.0/p.household_count > 0.02) hh_gt2pct,
      SUM(p.household_count IS NOT NULL AND a.hh_sum > p.household_count) hh_overcount,
      SUM(p.max_floor IS NOT NULL AND p.max_floor = a.max_fl) fl_exact,
      SUM(p.max_floor IS NOT NULL AND a.max_fl IS NOT NULL AND p.max_floor != a.max_fl) fl_diff
    FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    LEFT JOIN agg a ON a.complex_id=m.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  return bld.rows[0];
}

async function applyCollapse(db: Client, row: RecapRow, far: number, bcr: number) {
  const existing = await db.execute({
    sql: `SELECT far_ratio, bcr_ratio, raw_meta_json, source FROM apt_complex_profile WHERE complex_id=?`,
    args: [row.complex_id],
  });
  const cur = existing.rows[0] as
    | { far_ratio: number | null; bcr_ratio: number | null; raw_meta_json: string | null; source: string | null }
    | undefined;
  if (!cur) return { wrote: false, reason: "no_profile_row" };
  if (cur.far_ratio != null && cur.bcr_ratio != null) return { wrote: false, reason: "already_present" };
  if (cur.far_ratio != null && cur.far_ratio !== far) return { wrote: false, reason: "far_conflict" };
  if (cur.bcr_ratio != null && cur.bcr_ratio !== bcr) return { wrote: false, reason: "bcr_conflict" };
  let meta: Record<string, unknown> = {};
  if (cur.raw_meta_json) {
    try {
      meta = JSON.parse(cur.raw_meta_json) as Record<string, unknown>;
    } catch {
      meta = { prior_raw_meta: cur.raw_meta_json };
    }
  }
  const prev =
    meta.field_provenance && typeof meta.field_provenance === "object"
      ? { ...(meta.field_provenance as Record<string, unknown>) }
      : {};
  const prov = {
    source: "BUILDING_HUB_DUPLICATE_COLLAPSE",
    source_key: row.complex_id,
    raw: { rows: row.n, vlRat: far, bcRat: bcr },
    note: "all recap rows on the exact parcel share this value; other fields were not collapsed",
  };
  if (cur.far_ratio == null) prev.far_ratio = prov;
  if (cur.bcr_ratio == null) prev.bcr_ratio = prov;
  meta.field_provenance = prev;
  meta.profile_hero_phase2_at = nowIso();
  if (!APPLY) return { wrote: false, reason: "dry_run_fill", far, bcr };
  await db.execute({
    sql: `UPDATE apt_complex_profile SET
            far_ratio = COALESCE(far_ratio, ?),
            bcr_ratio = COALESCE(bcr_ratio, ?),
            raw_meta_json = ?,
            updated_at = ?
          WHERE complex_id = ?`,
    args: [far, bcr, JSON.stringify(meta), nowIso(), row.complex_id],
  });
  await db.execute({
    sql: `INSERT INTO apt_complex_source_links
            (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
          VALUES ('BUILDING_HUB_DUPLICATE_COLLAPSE', ?, ?, ?, 'profile-hero-phase2', ?, ?)
          ON CONFLICT(source, source_key) DO NOTHING`,
    args: [
      `recap:${row.complex_id}`,
      row.complex_id,
      JSON.stringify({ vlRat: far, bcRat: bcr, rows: row.n }),
      nowIso(),
      nowIso(),
    ],
  });
  return { wrote: true, far, bcr };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const before = await coverage(db);
  const parity = await validate(db);
  const audit = JSON.parse(
    readFileSync(resolve(OUT, "ambiguous-recap-audit.json"), "utf8"),
  ) as RecapRow[];

  const decisions = [];
  let fills = 0;
  let complexes = 0;
  for (const row of audit) {
    const far = sameValid(row.far, 2000);
    const bcr = sameValid(row.bcr, 100);
    if (far == null || bcr == null) {
      decisions.push({
        name: row.name,
        complex_id: row.complex_id,
        classification: "HOLD",
        reason: "recap_rows_disagree_or_invalid",
        far: row.far,
        bcr: row.bcr,
      });
      continue;
    }
    const result = await applyCollapse(db, row, far, bcr);
    decisions.push({ name: row.name, complex_id: row.complex_id, classification: result.wrote || result.reason === "dry_run_fill" ? "NULL_SAFE_FILL" : result.reason, ...result });
    if (result.wrote || result.reason === "dry_run_fill") {
      fills += (result.far != null ? 1 : 0) + (result.bcr != null ? 1 : 0);
      complexes += 1;
    }
  }

  const after = APPLY ? await coverage(db) : before;
  const report = {
    mode: APPLY ? "APPLY" : "DRY-RUN",
    before,
    after,
    parity,
    rejected_rules: {
      household_sum: "REJECTED systematic overcount vs known positives",
      building_row_count: "REJECTED exact parity 1310/2274 and 721 off-by-1 (profile often +1)",
      approval_min_max_modal: "REJECTED no per-building useAprDay stored; recap conflicts held",
      far_bcr_average: "REJECTED not used",
      heating_inference: "REJECTED no non-KAPT official heating field",
      parking_conflict_pick: "REJECTED material KAPT vs recap totals stay NULL",
    },
    duplicate_collapse: decisions,
    planned_or_applied_complexes: complexes,
    planned_or_applied_field_fills: APPLY ? decisions.filter((d) => d.classification === "NULL_SAFE_FILL" || (d as { wrote?: boolean }).wrote).length * 2 : complexes * 2,
  };
  writeFileSync(
    resolve(OUT, APPLY ? "phase2-apply.json" : "phase2-dry-run.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        complexes,
        field_fills: complexes * 2,
        parity,
        held: decisions.filter((d) => d.classification === "HOLD").length,
        buckets: after.buckets,
      },
      null,
      2,
    ),
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
