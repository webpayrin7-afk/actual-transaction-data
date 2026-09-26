/**
 * 단지 세대수(apt_complex_profile.household_count) 빈 칸 채우기 — 이미 DB에 있는 두 정확 원천이 서로 맞을 때만.
 *
 * 규칙 (추정 없음, API 호출 없음):
 *   ① 표제부 합: complex_buildings 주거동(residential_flag = 1)의 household_count 합.
 *      주거동이 한 개 이상이고 모두 status = EXACT, household_count가 NULL이 아닐 때만.
 *   ② 전유부 합: unit_type_household_counts(ui_safe = 1)의 household_count 합.
 *   ①과 ②가 0보다 크고 정확히 같으면 그 값. 다르거나 한쪽이 없으면 보류.
 * 빈 칸만: 이미 있는 프로필 행에서 household_count IS NULL일 때만 UPDATE (0이 든 행은 건드리지 않고 따로 셈).
 * 프로필 행이 없는 단지는 넣지 않는다(보류로 셈).
 * 출처는 raw_meta_json.field_provenance.household_count에 남긴다.
 *
 *   npx tsx scripts/fixes/fill-household-count.mts            # dry-run (기본, DB 쓰기 없음) — 계획 파일 저장
 *   npx tsx scripts/fixes/fill-household-count.mts --apply    # 계획을 다시 계산해 쓰기 (빈 칸 조건 걸고)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const OUT = "C:/data/fixes/household-count-2026-09-26";
const VERSION = "household_fill_2026_09";
const APPLY = process.argv.includes("--apply");

type Fill = { complexId: string; lawd: string; households: number; buildings: number; unitTypes: number };

const sidoOf = (lawd: string) => (lawd.startsWith("11") ? "서울" : lawd.startsWith("41") ? "경기" : "기타");

async function plan() {
  const db = getDb()!;
  // 대상: 프로필 행은 있는데 세대수가 NULL인 단지. 원천 합은 대상 단지로만 묶어서 계산.
  const res = await db.execute(`
    WITH t AS (
      SELECT p.complex_id, m.lawd_cd
      FROM apt_complex_profile p JOIN apt_complex_master m USING (complex_id)
      WHERE p.household_count IS NULL
    ),
    b AS (
      SELECT cb.complex_id, COUNT(*) AS n, SUM(cb.household_count) AS hh,
             SUM(cb.status <> 'EXACT' OR cb.household_count IS NULL) AS bad
      FROM complex_buildings cb JOIN t USING (complex_id)
      WHERE cb.residential_flag = 1
      GROUP BY cb.complex_id
    ),
    u AS (
      SELECT x.complex_id, COUNT(*) AS n, SUM(x.household_count) AS hh
      FROM unit_type_household_counts x JOIN t USING (complex_id)
      WHERE x.ui_safe = 1
      GROUP BY x.complex_id
    )
    SELECT t.complex_id, t.lawd_cd, b.n AS b_n, b.hh AS b_hh, b.bad AS b_bad, u.n AS u_n, u.hh AS u_hh
    FROM t LEFT JOIN b USING (complex_id) LEFT JOIN u USING (complex_id)`);

  const fills: Fill[] = [];
  const held: Record<string, number> = {};
  const hold = (k: string) => (held[k] = (held[k] ?? 0) + 1);
  const mismatchSample: Array<Record<string, unknown>> = [];
  for (const r of res.rows) {
    const bN = Number(r.b_n ?? 0);
    const bHh = Number(r.b_hh ?? 0);
    const uHh = Number(r.u_hh ?? 0);
    if (!bN) hold("NO_RESIDENTIAL_BUILDING");
    else if (Number(r.b_bad) > 0) hold("BUILDING_NOT_EXACT");
    else if (!r.u_n) hold("NO_UNIT_TYPE_COUNT");
    else if (bHh <= 0 || uHh <= 0) hold("ZERO_SUM");
    else if (bHh !== uHh) {
      hold("MISMATCH");
      if (mismatchSample.length < 5) mismatchSample.push({ complexId: r.complex_id, building: bHh, unitType: uHh });
    } else
      fills.push({ complexId: String(r.complex_id), lawd: String(r.lawd_cd), households: bHh, buildings: bN, unitTypes: Number(r.u_n) });
  }

  const zeroRows = await db.execute(`SELECT COUNT(*) AS n FROM apt_complex_profile WHERE household_count = 0`);
  const bySido = fills.reduce<Record<string, number>>((a, f) => ((a[sidoOf(f.lawd)] = (a[sidoOf(f.lawd)] ?? 0) + 1), a), {});
  const sizes = fills.map((f) => f.households).sort((a, b) => a - b);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, APPLY ? "plan-apply.json" : "plan-dry-run.json"), JSON.stringify({ built_at: new Date().toISOString(), fills }));
  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        targets: res.rows.length,
        fill: fills.length,
        bySido,
        held,
        mismatchSample,
        households: { min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], max: sizes.at(-1) },
        largest: [...fills].sort((a, b) => b.households - a.households).slice(0, 3),
        untouchedZeroRows: Number(zeroRows.rows[0]?.n ?? 0),
      },
      null,
      1,
    ),
  );
  return fills;
}

async function apply(fills: Fill[]) {
  const db = getDb()!;
  const now = new Date().toISOString();
  const prov = (f: Fill) =>
    JSON.stringify({
      source: "BUILDING_HUB_TITLE_SUM=UNIT_TYPE_EXPOS_SUM",
      source_key: f.complexId,
      derived: false,
      derived_tag: null,
      raw: f.households,
      building_rows: f.buildings,
      unit_types: f.unitTypes,
      fill: VERSION,
    });
  let updated = 0;
  for (let i = 0; i < fills.length; i += 100) {
    const part = fills.slice(i, i + 100);
    const res = await db.batch(
      part.map((f) => ({
        sql: `UPDATE apt_complex_profile
              SET household_count = ?, updated_at = ?,
                  raw_meta_json = json_set(COALESCE(raw_meta_json, '{}'), '$.field_provenance.household_count', json(?))
              WHERE complex_id = ? AND household_count IS NULL`,
        args: [f.households, now, prov(f), f.complexId],
      })),
      "write",
    );
    res.forEach((r) => (updated += r.rowsAffected));
  }
  console.log(JSON.stringify({ planned: fills.length, updated }));
}

const fills = await plan();
if (APPLY) await apply(fills);
