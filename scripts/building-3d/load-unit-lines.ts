/**
 * 건축물대장 전유공용면적(호 단위 가공본) → complex_unit_lines.
 * 쓰기는 complex_unit_lines 만. 추정·이름 매칭 없음.
 *
 * 원천 기본값: C:\data\buildinghub\2026-08\filtered\national_unit_building_evidence.csv.gz
 * (전유 + 주거공용으로 이미 합쳐진 호 1행. 전국 zip 을 다시 풀지 않는다.)
 *
 * 동 연결: 가공본 official_building_key = complex_buildings.mgm_bldrgst_pk 완전 일치만.
 * 전유부 관리번호(source_building_id)는 동 관리번호와 달라 쓰지 않는다. 키가 없으면 버린다.
 *
 *   npx tsx scripts/building-3d/load-unit-lines.ts            # dry-run
 *   npx tsx scripts/building-3d/load-unit-lines.ts --apply    # 비어 있거나 값이 다른 행만
 */
import { join } from "node:path";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: join(process.cwd(), "..", "..", "..", ".env.local") });

import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { getDb } from "../../src/lib/db/client";

const DEFAULT_EVIDENCE =
  "C:\\data\\buildinghub\\2026-08\\filtered\\national_unit_building_evidence.csv.gz";
const SOURCE_AS_OF = "2026-08";

type Building = { buildingId: string; complexId: string };

type Group = {
  buildingId: string;
  complexId: string;
  line: string;
  exclusive: number;
  supplies: Map<number, number>;
  floors: number[];
  unitCount: number;
};

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 호 이름에서 라인(끝 두 자리). 숫자가 아니거나 두 자리가 안 되면 사유를 돌려준다. */
export function lineOf(ho: string): { line: string } | { skip: "NON_NUMERIC_HO" | "NO_LINE" } {
  const s = ho.trim().replace(/호\s*$/u, "").trim();
  if (!/^\d+$/.test(s)) return { skip: "NON_NUMERIC_HO" };
  if (s.length < 2) return { skip: "NO_LINE" };
  return { line: s.slice(-2) };
}

function floorOf(raw: string): number | null {
  const t = raw.trim().replace(/층\s*$/u, "");
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function loadGroups(path: string, byPk: Map<string, Building>) {
  const skipped = {
    NO_BUILDING_PK: 0,
    NON_NUMERIC_HO: 0,
    NO_LINE: 0,
    NO_EXCLUSIVE: 0,
    BAD_AREA: 0,
  };
  const groups = new Map<string, Group>();
  let matchedUnits = 0;
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = splitCsv(line);
      continue;
    }
    const cols = splitCsv(line);
    const rec = (name: string) => cols[header!.indexOf(name)] ?? "";
    const pk = rec("official_building_key");
    const bld = pk ? byPk.get(pk) : undefined;
    if (!bld) {
      skipped.NO_BUILDING_PK++;
      continue;
    }
    matchedUnits++;
    const lined = lineOf(rec("ho"));
    if ("skip" in lined) {
      skipped[lined.skip]++;
      continue;
    }
    const exclusiveRaw = Number(rec("exclusive_area"));
    if (!Number.isFinite(exclusiveRaw) || exclusiveRaw <= 0) {
      skipped.NO_EXCLUSIVE++;
      continue;
    }
    const commonRaw = rec("residential_common_area").trim() === "" ? 0 : Number(rec("residential_common_area"));
    if (!Number.isFinite(commonRaw) || commonRaw < 0) {
      skipped.BAD_AREA++;
      continue;
    }
    const exclusive = r2(exclusiveRaw);
    const supply = r2(exclusiveRaw + commonRaw);
    const key = `${bld.buildingId}|${lined.line}|${exclusive.toFixed(2)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        buildingId: bld.buildingId,
        complexId: bld.complexId,
        line: lined.line,
        exclusive,
        supplies: new Map(),
        floors: [],
        unitCount: 0,
      };
      groups.set(key, g);
    }
    g.unitCount++;
    g.supplies.set(supply, (g.supplies.get(supply) ?? 0) + 1);
    const fl = floorOf(rec("floor"));
    if (fl != null) g.floors.push(fl);
  }
  return { groups, skipped, matchedUnits };
}

type Row = {
  buildingId: string;
  complexId: string;
  line: string;
  exclusive: number;
  supply: number;
  unitCount: number;
  floorMin: number | null;
  floorMax: number | null;
};

/** 같은 라인·전용에 공급면적이 여러 개면 호 수가 많은 값, 같으면 더 작은 값. 호는 버리지 않는다. */
function pickSupply(supplies: Map<number, number>): number {
  let best = 0;
  let bestN = -1;
  for (const [supply, n] of supplies) {
    if (n > bestN || (n === bestN && supply < best)) {
      best = supply;
      bestN = n;
    }
  }
  return best;
}

function toRows(groups: Map<string, Group>) {
  const rows: Row[] = [];
  let supplyConflictUnits = 0;
  let supplyConflictGroups = 0;
  for (const g of groups.values()) {
    if (g.supplies.size !== 1) {
      supplyConflictGroups++;
      supplyConflictUnits += g.unitCount;
    }
    const floors = g.floors;
    rows.push({
      buildingId: g.buildingId,
      complexId: g.complexId,
      line: g.line,
      exclusive: g.exclusive,
      supply: pickSupply(g.supplies),
      unitCount: g.unitCount,
      floorMin: floors.length ? Math.min(...floors) : null,
      floorMax: floors.length ? Math.max(...floors) : null,
    });
  }
  return { rows, supplyConflictGroups, supplyConflictUnits };
}

function same(a: Row, b: { supply: number; unitCount: number; floorMin: number | null; floorMax: number | null; complexId: string }) {
  return (
    a.complexId === b.complexId &&
    a.supply === b.supply &&
    a.unitCount === b.unitCount &&
    a.floorMin === b.floorMin &&
    a.floorMax === b.floorMax
  );
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const apply = process.argv.includes("--apply");
  const from = arg("from") ?? DEFAULT_EVIDENCE;

  const cb = await db.execute(
    "SELECT building_id, complex_id, mgm_bldrgst_pk FROM complex_buildings WHERE mgm_bldrgst_pk IS NOT NULL AND mgm_bldrgst_pk != ''",
  );
  const byPk = new Map<string, Building>();
  for (const r of cb.rows) {
    const pk = String(r.mgm_bldrgst_pk);
    if (byPk.has(pk)) throw new Error(`mgm_bldrgst_pk 중복: ${pk}`);
    byPk.set(pk, { buildingId: String(r.building_id), complexId: String(r.complex_id) });
  }

  const { groups, skipped, matchedUnits } = await loadGroups(from, byPk);
  const { rows, supplyConflictGroups, supplyConflictUnits } = toRows(groups);

  const exists =
    (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='complex_unit_lines'")).rows.length > 0;
  const have = new Map<string, { supply: number; unitCount: number; floorMin: number | null; floorMax: number | null; complexId: string }>();
  if (exists) {
    const prev = await db.execute(
      "SELECT building_id, complex_id, line, exclusive_area, supply_area, unit_count, floor_min, floor_max FROM complex_unit_lines",
    );
    for (const r of prev.rows) {
      const exclusive = r2(Number(r.exclusive_area));
      have.set(`${r.building_id}|${r.line}|${exclusive.toFixed(2)}`, {
        supply: r2(Number(r.supply_area)),
        unitCount: Number(r.unit_count),
        floorMin: r.floor_min == null ? null : Number(r.floor_min),
        floorMax: r.floor_max == null ? null : Number(r.floor_max),
        complexId: String(r.complex_id),
      });
    }
  }

  const changed: Row[] = [];
  let unchanged = 0;
  for (const row of rows) {
    const key = `${row.buildingId}|${row.line}|${row.exclusive.toFixed(2)}`;
    const prev = have.get(key);
    if (prev && same(row, prev)) unchanged++;
    else changed.push(row);
  }

  const links = await db.execute(
    "SELECT building_id, complex_id, SUM(household_count) AS households FROM unit_type_building_links GROUP BY building_id, complex_id",
  );
  const linkByBuilding = new Map<string, { complexId: string; households: number }>();
  for (const r of links.rows) {
    linkByBuilding.set(String(r.building_id), {
      complexId: String(r.complex_id),
      households: Number(r.households ?? 0),
    });
  }
  const lineByBuilding = new Map<string, { complexId: string; units: number }>();
  for (const row of rows) {
    const cur = lineByBuilding.get(row.buildingId) ?? { complexId: row.complexId, units: 0 };
    cur.units += row.unitCount;
    lineByBuilding.set(row.buildingId, cur);
  }
  const mismatches: Array<{ buildingId: string; complexId: string; lineUnits: number; linkHouseholds: number }> = [];
  for (const [buildingId, line] of lineByBuilding) {
    const link = linkByBuilding.get(buildingId);
    const households = link?.households ?? 0;
    if (households !== line.units) {
      mismatches.push({
        buildingId,
        complexId: line.complexId,
        lineUnits: line.units,
        linkHouseholds: households,
      });
    }
  }
  mismatches.sort((a, b) => Math.abs(b.lineUnits - b.linkHouseholds) - Math.abs(a.lineUnits - a.linkHouseholds));

  const complexes = new Set(rows.map((r) => r.complexId));
  const buildings = new Set(rows.map((r) => r.buildingId));
  const report = {
    mode: apply ? "apply" : "dry-run",
    source: from,
    match: "official_building_key = complex_buildings.mgm_bldrgst_pk",
    matched_units: matchedUnits,
    load: {
      complexes: complexes.size,
      buildings: buildings.size,
      lines: rows.length,
      units: rows.reduce((a, r) => a + r.unitCount, 0),
    },
    skipped_units: skipped,
    supply_variants: { groups: supplyConflictGroups, units: supplyConflictUnits, rule: "most units, then smaller supply" },
    write: { insert_or_update: changed.length, unchanged, existing_rows: have.size },
    household_mismatch_buildings: mismatches.length,
  };
  console.log(JSON.stringify(report, null, 2));

  const outDir = join(process.cwd(), "data", "poc", "unit-lines");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "mismatch.json"), JSON.stringify(mismatches));
  writeFileSync(join(outDir, "dry-run.json"), JSON.stringify(report, null, 2));

  if (!apply) return;
  if (changed.length === 0) {
    console.log(JSON.stringify({ applied: 0 }));
    return;
  }

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260924_complex_unit_lines.sql"), "utf8");
  for (const stmt of ddl
    .split(/;\s*\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)) {
    await db.execute(stmt);
  }

  let affected = 0;
  const batch = 200;
  for (let i = 0; i < changed.length; i += batch) {
    const chunk = changed.slice(i, i + batch);
    const res = await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO complex_unit_lines (
                building_id, complex_id, line, exclusive_area, supply_area, unit_count, floor_min, floor_max, source_as_of
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (building_id, line, exclusive_area) DO UPDATE SET
                complex_id = excluded.complex_id,
                supply_area = excluded.supply_area,
                unit_count = excluded.unit_count,
                floor_min = excluded.floor_min,
                floor_max = excluded.floor_max,
                source_as_of = excluded.source_as_of
              WHERE complex_id IS NOT excluded.complex_id
                 OR supply_area IS NOT excluded.supply_area
                 OR unit_count IS NOT excluded.unit_count
                 OR floor_min IS NOT excluded.floor_min
                 OR floor_max IS NOT excluded.floor_max
                 OR source_as_of IS NOT excluded.source_as_of`,
        args: [r.buildingId, r.complexId, r.line, r.exclusive, r.supply, r.unitCount, r.floorMin, r.floorMax, SOURCE_AS_OF],
      })),
      "write",
    );
    affected += res.reduce((a, x) => a + x.rowsAffected, 0);
    if ((i / batch) % 20 === 0) console.log(JSON.stringify({ wrote: Math.min(i + chunk.length, changed.length), of: changed.length }));
  }
  console.log(JSON.stringify({ applied: affected }));
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/building-3d/load-unit-lines.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
