/**
 * G2 supply fill from local 건축HUB rows and a cadastre-confirmed PNU.
 *
 * plan  — dry-run, no writes
 * apply — update only NO_SOURCE rows (supply_cents = -1). Never overwrites a
 *         positive supply and never deletes a row.
 *
 * An exclusive with more than one derived supply is held. Name similarity is not used.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/fill-g2-local.mts plan|apply
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { config } from "dotenv";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  NO_SUPPLY_CENTS,
} from "../../src/lib/unit-type/canonical";
import { deriveOfficialSupplies, type ExposRow } from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

config({ path: ".env.local", quiet: true });

// Overridable for the parcel relink (scripts/supply-fill/relink): same logic, other inputs.
const CADASTRAL = process.env.G2_TARGETS ?? "data/poc/supply/g2-pnu-cadastre.jsonl";
const EXPOS = process.env.G2_EXPOS_FILE ?? "data/poc/supply/g2-expos.jsonl";
const RECOVERY = process.env.G2_RECOVERY ?? "supply_fill_local_g2_2026_09";
const OUT_DIR = process.env.G2_OUT_DIR ?? "data/poc/supply";

type ComplexRow = {
  complexId: string;
  aptName: string;
  pnu: string;
  cadastre: string;
  identityStatus: string;
  t3y: number;
  trades: number;
};

type ExposFileRow = ExposRow & {
  pnu: string;
  exposCd?: string;
  mainAtchCd?: string;
  mainPurpsCd?: string;
};

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toExpos(row: ExposFileRow): ExposRow {
  let expos = str(row.exposPubuseGbCdNm);
  if (!expos && row.exposCd === "1") expos = "전유";
  if (!expos && row.exposCd === "2") expos = "공용";
  let atch = str(row.mainAtchGbCdNm);
  if (!atch && row.mainAtchCd === "0") atch = "주건축물";
  if (!atch && row.mainAtchCd === "1") atch = "부속건축물";
  let purps = str(row.mainPurpsCdNm);
  if (!purps && row.mainPurpsCd === "02001") purps = "아파트";
  return {
    dongNm: str(row.dongNm),
    hoNm: str(row.hoNm),
    flrNo: str(row.flrNo),
    exposPubuseGbCdNm: expos,
    mainAtchGbCdNm: atch,
    mainPurpsCdNm: purps,
    etcPurps: str(row.etcPurps),
    area: row.area,
    bldNm: "",
  };
}

async function main() {
  const apply = process.argv[2] === "apply";
  const complexes = readFileSync(CADASTRAL, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComplexRow);
  const wanted = new Set(complexes.filter((row) => row.cadastre === "EXISTS" && row.pnu).map((row) => row.pnu));
  const byPnu = new Map<string, ExposRow[]>();
  const exposLines = createInterface({ input: createReadStream(EXPOS, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of exposLines) {
    if (!line) continue;
    const row = JSON.parse(line) as ExposFileRow;
    if (!wanted.has(row.pnu)) continue;
    const list = byPnu.get(row.pnu) ?? [];
    list.push(toExpos(row));
    byPnu.set(row.pnu, list);
  }
  const pnuOwners = new Map<string, number>();
  for (const row of complexes) {
    if (!row.pnu) continue;
    pnuOwners.set(row.pnu, (pnuOwners.get(row.pnu) ?? 0) + 1);
  }

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const existing = new Map<string, Map<number, number>>();
  for (const part of chunks(complexes.map((row) => row.complexId), 300)) {
    const res = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_cents FROM apt_canonical_unit_types
            WHERE complex_id IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const row of res.rows) {
      const id = str(row.complex_id);
      const bucket = existing.get(id) ?? new Map<number, number>();
      const ex = num(row.exclusive_cents);
      bucket.set(ex, (bucket.get(ex) ?? 0) + (num(row.supply_cents) >= 0 ? 1 : 0));
      if (!bucket.has(ex)) bucket.set(ex, 0);
      existing.set(id, bucket);
    }
  }

  const now = new Date().toISOString();
  const totals = {
    complexes: complexes.length,
    recovered: 0,
    recovered3y: 0,
    fullAfter: 0,
    fullAfter3y: 0,
    exclusivesFilled: 0,
    held: {} as Record<string, number>,
    with3y: complexes.filter((row) => row.t3y > 0).length,
  };
  const statements: { sql: string; args: InArgs }[] = [];
  const hold = (key: string) => {
    totals.held[key] = (totals.held[key] ?? 0) + 1;
  };

  for (const row of complexes) {
    if (!row.pnu || row.cadastre !== "EXISTS") {
      hold(row.cadastre === "ABSENT" ? "CADASTRE_ABSENT" : row.identityStatus || "NO_PNU");
      continue;
    }
    if ((pnuOwners.get(row.pnu) ?? 0) > 1) {
      hold("SHARED_PNU");
      continue;
    }
    const rows = byPnu.get(row.pnu) ?? [];
    if (rows.length === 0) {
      hold("NO_EXPOS_ROWS");
      continue;
    }
    const derived = deriveOfficialSupplies(rows, row.aptName);
    if (!derived.distinguishable) {
      hold(derived.supplies.length === 0 ? "NO_DERIVABLE" : "COMMON_SEMANTICS_UNCLEAR");
      continue;
    }
    const byEx = new Map<number, typeof derived.supplies>();
    for (const supply of derived.supplies) {
      const list = byEx.get(supply.exclusiveCents) ?? [];
      list.push(supply);
      byEx.set(supply.exclusiveCents, list);
    }
    const owned = existing.get(row.complexId) ?? new Map<number, number>();
    let filled = 0;
    let emptyLeft = 0;
    for (const [ex, positive] of owned) {
      if (positive > 0) continue;
      const variants = byEx.get(ex) ?? [];
      if (variants.length !== 1) {
        emptyLeft += 1;
        continue;
      }
      const variant = variants[0]!;
      const supplyArea = areaFromCents(variant.supplyCents);
      statements.push({
        sql: `UPDATE apt_canonical_unit_types
              SET supply_area = ?, supply_cents = ?, supply_pyeong = ?, display_pyeong_label = ?,
                  household_count = ?, source = 'BldRgstHubService', source_key = ?, source_as_of = '',
                  confidence = 'building_registry_expos', status = 'EXACT_SINGLE', formula = ?,
                  provenance_json = ?, updated_at = ?
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents = ? AND status = 'NO_SOURCE'`,
        args: [
          supplyArea,
          variant.supplyCents,
          canonicalSupplyPyeong(supplyArea),
          supplyPyeongDisplayLabel(supplyArea),
          variant.householdCount,
          `${row.pnu}:${ex}:${variant.supplyCents}`,
          variant.formula,
          JSON.stringify({
            formula: variant.formula,
            residential_common_area: variant.residentialCommonArea,
            household_count: variant.householdCount,
            recovery: RECOVERY,
            pnu: row.pnu,
            identity: row.identityStatus,
          }),
          now,
          row.complexId,
          ex,
          NO_SUPPLY_CENTS,
        ],
      });
      statements.push({
        sql: `UPDATE apt_unit_exclusive_pairs
              SET resolution_status = 'EXACT_SINGLE', supply_variant_count = 1,
                  observed_from = CASE WHEN observed_from LIKE '%official_expos%' THEN observed_from ELSE observed_from || '+official_expos' END
              WHERE complex_id = ? AND exclusive_cents = ? AND resolution_status = 'NO_SOURCE'`,
        args: [row.complexId, ex],
      });
      filled += 1;
    }
    if (filled === 0) {
      hold("EXCLUSIVE_NOT_MATCHED");
      continue;
    }
    totals.recovered += 1;
    totals.exclusivesFilled += filled;
    if (row.t3y > 0) totals.recovered3y += 1;
    if (emptyLeft === 0) {
      totals.fullAfter += 1;
      if (row.t3y > 0) totals.fullAfter3y += 1;
    }
  }

  if (apply) {
    let affected = 0;
    for (const part of chunks(statements, 40)) {
      const results = await db.batch(part, "write");
      affected += results.reduce((n, result) => n + result.rowsAffected, 0);
    }
    totals.recovered = totals.recovered;
    writeFileSync(`${OUT_DIR}/g2-apply.json`, JSON.stringify({ at: now, affected, totals }, null, 2));
    console.log(JSON.stringify({ apply: true, affected, ...totals }, null, 2));
  } else {
    writeFileSync(
      `${OUT_DIR}/g2-plan-rows.jsonl`,
      statements
        .filter((s) => s.sql.includes("apt_canonical_unit_types"))
        .map((s) => {
          const a = s.args as unknown[];
          return JSON.stringify({ complexId: a[9], exclusiveCents: a[10], supplyCents: a[1], households: a[4], sourceKey: a[5] });
        })
        .join("\n") + "\n",
    );
    writeFileSync(
      `${OUT_DIR}/g2-plan.json`,
      JSON.stringify({ at: now, statements: statements.length, totals }, null, 2),
    );
    console.log(JSON.stringify({ apply: false, statements: statements.length, ...totals }, null, 2));
  }
  void (db as Client);
}

main();
