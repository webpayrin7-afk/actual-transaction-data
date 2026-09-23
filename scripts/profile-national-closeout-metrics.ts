#!/usr/bin/env npx tsx
/**
 * One-shot AFTER metrics for national PROFILE closeout final report.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OUT,
  coreChipCount,
  heroBucket,
  openDb,
  type ProfileSnap,
} from "./profile-national-lib";

function regionOfLawd(lawd: string): string {
  const p = String(lawd || "").slice(0, 2);
  const map: Record<string, string> = {
    "11": "SEOUL",
    "41": "GYEONGGI",
    "28": "INCHEON",
    "26": "BUSAN",
    "27": "DAEGU",
    "30": "DAEJEON",
    "31": "ULSAN",
    "36": "SEJONG",
    "51": "GANGWON",
    "42": "GANGWON",
    "43": "CHUNGBUK",
    "44": "CHUNGNAM",
    "52": "JEONBUK",
    "45": "JEONBUK",
    "47": "GYEONGBUK",
    "48": "GYEONGNAM",
    "50": "JEJU",
    "29": "GWANGJU_JEONNAM",
    "46": "GWANGJU_JEONNAM",
    "12": "GWANGJU_JEONNAM",
  };
  return map[p] || `OTHER_${p}`;
}

async function main() {
  const db = openDb();
  const r = await db.execute(`
    SELECT m.complex_id, m.lawd_cd, m.apt_name,
      p.household_count, p.building_count, p.approval_date, p.max_floor,
      p.parking_per_household, p.far_ratio, p.bcr_ratio, p.heating_type,
      p.parking_total
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
  `);

  const buckets: Record<string, number> = {
    FULL_HERO: 0,
    GOOD_HERO: 0,
    PARTIAL_HERO: 0,
    NO_PROFILE: 0,
  };
  const byReg: Record<string, Record<string, number>> = {};
  const chips: Record<string, { zero: number; one: number; two_plus: number; three: number }> =
    {};

  for (const row of r.rows) {
    const snap: Partial<ProfileSnap> = {
      household_count: row.household_count as number | null,
      building_count: row.building_count as number | null,
      approval_date: row.approval_date as string | null,
      max_floor: row.max_floor as number | null,
      parking_per_household: row.parking_per_household as number | null,
      far_ratio: row.far_ratio as number | null,
      bcr_ratio: row.bcr_ratio as number | null,
      heating_type: row.heating_type as string | null,
    };
    const bucket = heroBucket(snap);
    buckets[bucket]!++;
    const reg = regionOfLawd(String(row.lawd_cd || ""));
    byReg[reg] ||= {
      FULL_HERO: 0,
      GOOD_HERO: 0,
      PARTIAL_HERO: 0,
      NO_PROFILE: 0,
    };
    byReg[reg]![bucket]!++;
    if (reg === "SEOUL" || reg === "GYEONGGI") {
      chips[reg] ||= { zero: 0, one: 0, two_plus: 0, three: 0 };
      const n = coreChipCount(snap);
      if (n === 0) chips[reg]!.zero++;
      else if (n === 1) chips[reg]!.one++;
      else {
        chips[reg]!.two_plus++;
        if (n === 3) chips[reg]!.three++;
      }
    }
  }

  const jamsil = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name, p.household_count, p.building_count,
            p.approval_date, p.max_floor, p.far_ratio, p.bcr_ratio, p.heating_type,
            p.parking_total, p.parking_per_household
          FROM apt_complex_master m
          JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE m.apt_name LIKE '%잠실엘스%'
          LIMIT 5`,
    args: [],
  });

  // Gyeonggi representative: 분당 시범한양
  const bundang = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name, m.lawd_cd,
            p.household_count, p.building_count, p.approval_date, p.max_floor,
            p.far_ratio, p.bcr_ratio, p.heating_type, p.parking_per_household
          FROM apt_complex_master m
          LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE m.apt_name LIKE '%시범한양%'
          LIMIT 10`,
    args: [],
  });

  const out = {
    at: new Date().toISOString(),
    total: r.rows.length,
    buckets,
    byReg,
    chips,
    jamsil_els: jamsil.rows,
    bundang_sibom: bundang.rows,
  };
  writeFileSync(resolve(OUT, "after-hero-buckets.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
