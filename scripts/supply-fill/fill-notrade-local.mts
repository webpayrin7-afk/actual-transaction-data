/**
 * Phase 3: supply types for no-trade complexes that have NO canonical unit-type row.
 *
 * Identity: K-apt 법정동주소 → PNU (PNU_EXACT, legal code = master code) confirmed in the
 * 2026-09 continuous cadastre (all DBF parts). Registry: local 전유공용면적 2026-08 rows at
 * that parcel, under ONE code (DB code first, predecessor code only if the DB code has no rows).
 * Supply = 전유 + 주거공용 (deriveOfficialSupplies; types with < 3 units are dropped there).
 * No name matching. Shared parcels (another master complex on the same PNU) are held.
 *
 * Writes (apply only), all insert-only:
 *   apt_canonical_unit_types  INSERT … WHERE the complex still has no row from any other fill
 *   apt_unit_exclusive_pairs  INSERT (trade counts 0) ON CONFLICT DO NOTHING
 *   apt_unit_supply_representative  for an exclusive with 2+ supplies (most households, tie → smaller)
 * Never updates or deletes an existing row.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/fill-notrade-local.mts plan|apply [sidoPrefix]
 *   sidoPrefix = 2-digit lawd prefix (12, 26, 27, 28, 30, 31, 36, 43, 44, 47, 48, 50, 51, 52) or omitted = all
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { config } from "dotenv";
import { createClient, type InArgs } from "@libsql/client";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  resolutionStatus,
} from "../../src/lib/unit-type/canonical";
import { deriveOfficialSupplies, type ExposRow } from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";
import { pickRepresentativeSupply, pyeongRangeLabel } from "../../src/lib/unit-type/supply-representative";

config({ path: ".env.local", quiet: true });

const TARGETS = "data/poc/supply/nt-pnu-cadastre.jsonl";
const EXPOS = "data/poc/supply/nt-expos.jsonl";
const RECOVERY = "supply_fill_local_nt_2026_09";
const RULE = "max_household_then_smaller_supply";
/** Held when the kept types cover fewer than this share of the parcel's apartment units. */
const MIN_COVERAGE = 0.5;
/** Held when any derived supply exceeds this multiple of its exclusive area. */
const MAX_RATIO = 1.7;

type Target = {
  complexId: string;
  aptName: string;
  lawdCd: string;
  sido: string;
  sigungu: string;
  cadastrePnu: string;
  registryPnus: string[];
  identityStatus: string;
  cadastre: string;
  pnuOwners: number;
};

type FileRow = ExposRow & { pnu: string; exposCd?: string; mainAtchCd?: string; mainPurpsCd?: string };

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

function toExpos(row: FileRow): ExposRow {
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
    bldNm: "", // name is never a join key
  };
}

function isUnreasonable(exclusive: number, supply: number): boolean {
  if (!(exclusive > 0) || !(supply > exclusive)) return true;
  const ratio = supply / exclusive;
  if (ratio > 5) return true;
  if (exclusive < 10 && ratio > 3) return true;
  return false;
}

async function main() {
  const apply = process.argv[2] === "apply";
  const prefix = process.argv[3] ?? "";
  const targets = readFileSync(TARGETS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Target)
    .filter((t) => !prefix || t.lawdCd.startsWith(prefix));
  const wanted = new Set(targets.flatMap((t) => t.registryPnus));
  const byPnu = new Map<string, ExposRow[]>();
  if (!prefix) throw new Error("pass a sido prefix; one sido per run (memory)");
  const exposFile = EXPOS.replace(".jsonl", `-${prefix}.jsonl`);
  if (!existsSync(exposFile)) throw new Error(`${exposFile} missing — run scan-buildinghub-pnus.py + split-nt-expos.py first`);
  const rl = createInterface({ input: createReadStream(exposFile, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const row = JSON.parse(line) as FileRow;
    if (!wanted.has(row.pnu)) continue;
    const list = byPnu.get(row.pnu) ?? [];
    list.push(toExpos(row));
    byPnu.set(row.pnu, list);
  }

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  // Complexes that already have a canonical row from anything other than this fill are skipped.
  const foreign = new Set<string>();
  const ours = new Set<string>();
  const ids = targets.map((t) => t.complexId);
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    const res = await db.execute({
      sql: `SELECT complex_id, SUM(provenance_json LIKE '%${RECOVERY}%') ours, SUM(provenance_json NOT LIKE '%${RECOVERY}%') other
            FROM apt_canonical_unit_types WHERE complex_id IN (${part.map(() => "?").join(",")}) GROUP BY complex_id`,
      args: part,
    });
    for (const row of res.rows) {
      if (num(row.other) > 0) foreign.add(str(row.complex_id));
      else if (num(row.ours) > 0) ours.add(str(row.complex_id));
    }
  }

  const now = new Date().toISOString();
  const held: Record<string, number> = {};
  const hold = (k: string) => (held[k] = (held[k] ?? 0) + 1);
  const planRows: unknown[] = [];
  const statements: { sql: string; args: InArgs }[] = [];
  const bySido: Record<string, { targeted: number; filled: number; held: Record<string, number> }> = {};
  let filled = 0;
  let types = 0;
  let multiExclusives = 0;
  let rangeLabels = 0;
  let predecessorUsed = 0;
  let alreadyOurs = 0; // re-run: statements are re-issued but must affect 0 rows
  const lawdFilled = new Map<string, number>();

  for (const t of targets) {
    const sidoKey = t.lawdCd.slice(0, 2);
    const s = (bySido[sidoKey] ??= { targeted: 0, filled: 0, held: {} });
    s.targeted += 1;
    const sHold = (k: string) => {
      hold(k);
      s.held[k] = (s.held[k] ?? 0) + 1;
    };
    if (t.identityStatus !== "AS_IS" && t.identityStatus !== "REMAPPED") {
      sHold(t.identityStatus);
      continue;
    }
    if (t.cadastre !== "EXISTS") {
      sHold("CADASTRE_ABSENT");
      continue;
    }
    if (t.pnuOwners > 1) {
      sHold("SHARED_PNU");
      continue;
    }
    if (foreign.has(t.complexId)) {
      sHold("ALREADY_HAS_TYPES");
      continue;
    }
    const usedPnu = t.registryPnus.find((p) => (byPnu.get(p)?.length ?? 0) > 0);
    if (!usedPnu) {
      sHold("NO_EXPOS_ROWS");
      continue;
    }
    const rows = byPnu.get(usedPnu)!;
    const derived = deriveOfficialSupplies(rows, t.aptName);
    const aptUnits = derived.units.length;
    if (aptUnits === 0) {
      sHold("NO_APT_EXCLUSIVE");
      continue;
    }
    if (!derived.distinguishable) {
      sHold(derived.supplies.length === 0 ? "NO_DERIVABLE" : "COMMON_SEMANTICS_UNCLEAR");
      continue;
    }
    const supplies = derived.supplies.filter((v) => !isUnreasonable(v.exclusiveArea, v.supplyArea));
    const kept = supplies.reduce((n, v) => n + v.householdCount, 0);
    if (supplies.length === 0) {
      sHold("NO_DERIVABLE");
      continue;
    }
    // Review guard: 전유+주거공용 above 1.7× exclusive is not a plausible supply (parking or
    // other shared space leaked into the allowlist). Hold the whole complex.
    if (supplies.some((v) => v.supplyArea / v.exclusiveArea > MAX_RATIO)) {
      sHold("IMPLAUSIBLE_RATIO");
      continue;
    }
    if (kept / aptUnits < MIN_COVERAGE) {
      sHold("LOW_COVERAGE");
      continue;
    }
    const byEx = new Map<number, typeof supplies>();
    for (const v of supplies) {
      const list = byEx.get(v.exclusiveCents) ?? [];
      list.push(v);
      byEx.set(v.exclusiveCents, list);
    }
    if (usedPnu !== t.registryPnus[0]) predecessorUsed += 1;
    const guard = `NOT EXISTS (SELECT 1 FROM apt_canonical_unit_types g WHERE g.complex_id = ? AND g.provenance_json NOT LIKE '%${RECOVERY}%')`;
    for (const [ex, variants] of byEx) {
      const status = resolutionStatus(variants.length, false);
      for (const v of variants) {
        statements.push({
          sql: `INSERT INTO apt_canonical_unit_types (
                  unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                  supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                  source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
                )
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'BldRgstHubBulk', ?, '2026-08', 'building_registry_expos', ?, ?, ?, ?, ?
                WHERE ${guard}
                ON CONFLICT DO NOTHING`,
          args: [
            canonicalUnitTypeId(t.complexId, ex, v.supplyCents),
            t.complexId,
            v.exclusiveArea,
            ex,
            v.supplyArea,
            v.supplyCents,
            canonicalSupplyPyeong(v.supplyArea),
            supplyPyeongDisplayLabel(v.supplyArea),
            v.householdCount,
            `${usedPnu}:${ex}:${v.supplyCents}`,
            status,
            v.formula,
            JSON.stringify({
              recovery: RECOVERY,
              formula: v.formula,
              residential_common_area: v.residentialCommonArea,
              household_count: v.householdCount,
              registry_pnu: usedPnu,
              cadastre_pnu: t.cadastrePnu,
              identity: "KAPT_PNU_EXACT+CADASTRE",
              bulk_source_month: "2026-08",
            }),
            now,
            now,
            t.complexId,
          ],
        });
        types += 1;
      }
      statements.push({
        sql: `INSERT INTO apt_unit_exclusive_pairs (
                complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
                latest_trade_date, resolution_status, supply_variant_count, observed_from
              ) SELECT ?, ?, ?, 0, 0, 0, '', ?, ?, 'official_expos_local'
              WHERE ${guard}
              ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
        args: [t.complexId, ex, areaFromCents(ex), status, variants.length, t.complexId],
      });
      if (variants.length > 1) {
        multiExclusives += 1;
        const pick = pickRepresentativeSupply(variants.map((v) => ({ supplyCents: v.supplyCents, householdCount: v.householdCount })));
        if (pick) {
          if (pyeongRangeLabel(pick.variants.map((v) => v.supplyCents)).includes("~")) rangeLabels += 1;
          statements.push({
            sql: `INSERT INTO apt_unit_supply_representative (
                    complex_id, exclusive_cents, representative_supply_cents, representative_household_count,
                    variant_count, variants_json, rule, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
            args: [
              t.complexId,
              ex,
              pick.representativeSupplyCents,
              pick.representativeHouseholdCount,
              pick.variants.length,
              JSON.stringify(pick.variants),
              RULE,
              now,
            ],
          });
        }
      }
    }
    if (ours.has(t.complexId)) alreadyOurs += 1;
    filled += 1;
    s.filled += 1;
    lawdFilled.set(t.lawdCd, (lawdFilled.get(t.lawdCd) ?? 0) + 1);
    planRows.push({
      complexId: t.complexId,
      aptName: t.aptName,
      lawdCd: t.lawdCd,
      pnu: usedPnu,
      aptUnits,
      keptHouseholds: kept,
      types: supplies.map((v) => [v.exclusiveCents, v.supplyCents, v.householdCount]),
    });
  }

  const summary = {
    prefix: prefix || "ALL",
    targeted: targets.length,
    filled,
    types,
    multiExclusives,
    rangeLabels,
    predecessorUsed,
    alreadyOurs,
    held,
    bySido,
    lawdCodes: Object.fromEntries([...lawdFilled.entries()].sort()),
  };
  const tag = prefix || "all";
  if (!apply) {
    writeFileSync(`data/poc/supply/nt-plan-${tag}.json`, JSON.stringify({ at: now, statements: statements.length, ...summary }, null, 1));
    writeFileSync(`data/poc/supply/nt-plan-${tag}-rows.jsonl`, planRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(JSON.stringify({ apply: false, statements: statements.length, ...summary, bySido: undefined, lawdCodes: undefined }));
    return;
  }
  let affected = 0;
  for (let i = 0; i < statements.length; i += 100) {
    const results = await db.batch(statements.slice(i, i + 100), "write");
    affected += results.reduce((n, r) => n + r.rowsAffected, 0);
  }
  writeFileSync(`data/poc/supply/nt-apply-${tag}.json`, JSON.stringify({ at: now, affected, statements: statements.length, ...summary }, null, 1));
  console.log(JSON.stringify({ apply: true, affected, statements: statements.length, ...summary, bySido: undefined, lawdCodes: undefined }));
}

main();
