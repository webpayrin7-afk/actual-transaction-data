/**
 * Materialize price-position-v2.3 for every supply-pyeong decade.
 * Does not update or delete V2 / V2.1 / V2.2 rows.
 *
 * Usage:
 *   tsx scripts/region-ranking/build-price-position-v23.mts
 *   tsx scripts/region-ranking/build-price-position-v23.mts --apply
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import { median } from "../../src/lib/region-ranking/objective-rank";
import { buildComplexMonthValues } from "../../src/lib/region-ranking/price-position-v21-audit";
import { pooledWindowMean, resolveRegionWindowV23 } from "../../src/lib/region-ranking/region-trend-window";
import {
  changePercentV2,
  exactSupplyPyeong,
  pricePerSupplyPyeong,
  type ComplexIdentityV2,
  type SupplySalePoint,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  applyExactComplexMarketLabel,
  PRICE_POSITION_V21_AS_OF,
  TREND_HORIZONS_V21,
  type PricePositionBodyV21,
} from "../../src/lib/region-ranking/price-position-v21";
import { decadeCohortForLabel, pricePositionV22SnapshotId } from "../../src/lib/region-ranking/price-position-v22";
import {
  DECADE_COHORTS_V22,
  METHODOLOGY_FINGERPRINT_V23,
  PRICE_POSITION_V23_VERSION,
  buildPricePositionV23,
  pricePositionV23SnapshotId,
} from "../../src/lib/region-ranking/price-position-v23";

const AS_OF = PRICE_POSITION_V21_AS_OF;
const FLOOR_YM = "202107";
const ASOF_YM = "202609";
const APPLY = process.argv.includes("--apply");
const SNAP23 = pricePositionV23SnapshotId();
const SNAP22 = pricePositionV22SnapshotId();
const BATCH = 40;
const REPORT = "/tmp/building-hub-bulk/external-evidence/v23-publish-report.json";
const JAMSIL = "cx_4c63d9a100973c60";
const PILOTS: Record<string, string> = {
  잠실엘스: JAMSIL,
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
  트리지움: "cx_85cd8a4b2d5dc3d0",
};

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function countSnap(db: Client, snapshotId: string): Promise<{ rows: number; complexes: number }> {
  const rows = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [snapshotId] })).rows[0]?.n,
  );
  const complexes = num(
    (
      await db.execute({
        sql: `SELECT COUNT(DISTINCT complex_id) n FROM complex_region_price_position WHERE snapshot_id=?`,
        args: [snapshotId],
      })
    ).rows[0]?.n,
  );
  return { rows, complexes };
}

function sameNum(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

function priceLevelEqual(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  if (left.priceLevel.length !== right.priceLevel.length) return false;
  for (const scope of ["COMPLEX", "DONG", "GU", "SEOUL"] as const) {
    const a = left.priceLevel.find((cell) => cell.scope === scope);
    const b = right.priceLevel.find((cell) => cell.scope === scope);
    if (!a || !b) return false;
    if (a.status !== b.status) return false;
    if (!sameNum(a.meanPricePerSupplyPyeong, b.meanPricePerSupplyPyeong)) return false;
    if (!sameNum(a.tradeCount, b.tradeCount)) return false;
    if (!sameNum(a.sampleCount, b.sampleCount)) return false;
    if (!sameNum(a.contributingComplexCount, b.contributingComplexCount)) return false;
    if (a.referenceMonth !== b.referenceMonth) return false;
  }
  return true;
}

function complexTrendEqual(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  for (const horizon of TREND_HORIZONS_V21) {
    const a = left.trends[horizon].find((cell) => cell.scope === "COMPLEX");
    const b = right.trends[horizon].find((cell) => cell.scope === "COMPLEX");
    if (!a || !b) return false;
    if (a.status !== b.status || !sameNum(a.changePercent, b.changePercent)) return false;
    if (a.actualCurrentMonth !== b.actualCurrentMonth || a.actualBaselineMonth !== b.actualBaselineMonth) return false;
  }
  const leftLabels = Object.keys(left.complexExactByMarketLabel ?? {}).sort();
  const rightLabels = Object.keys(right.complexExactByMarketLabel ?? {}).sort();
  if (leftLabels.join(",") !== rightLabels.join(",")) return false;
  for (const label of leftLabels) {
    for (const horizon of TREND_HORIZONS_V21) {
      const a = left.complexExactByMarketLabel[label]?.trends[horizon];
      const b = right.complexExactByMarketLabel[label]?.trends[horizon];
      if (!a || !b) return false;
      if (a.status !== b.status || !sameNum(a.changePercent, b.changePercent)) return false;
      if (!sameNum(a.currentMean, b.currentMean) || !sameNum(a.baselineMean, b.baselineMean)) return false;
    }
  }
  return true;
}

function regionTrendChanged(left: PricePositionBodyV21, right: PricePositionBodyV21): boolean {
  for (const horizon of TREND_HORIZONS_V21) {
    for (const scope of ["DONG", "GU", "SEOUL"] as const) {
      const a = left.trends[horizon].find((cell) => cell.scope === scope);
      const b = right.trends[horizon].find((cell) => cell.scope === scope);
      if (!sameNum(a?.changePercent ?? null, b?.changePercent ?? null)) return true;
      if ((a?.matchedComplexCount ?? null) !== (b?.matchedComplexCount ?? null)) return true;
    }
  }
  return false;
}

async function main() {
  const db = client();
  const before23 = await countSnap(db, SNAP23);
  const before22 = await countSnap(db, SNAP22);
  const beforeV2 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
  );
  const beforeV21 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
  );
  console.log(`before v2=${beforeV2} v21=${beforeV21} v22=${before22.rows}/${before22.complexes} v23=${before23.rows}/${before23.complexes}`);

  const lawds = seoulLawdCodes();
  const identities = new Map<string, ComplexIdentityV2>();
  const byName = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const lawd of lawds) {
    const masters = await db.execute({
      sql: `SELECT complex_id, bjdong_cd, apt_name, apt_name_norm, legal_dong_name
            FROM apt_complex_master WHERE lawd_cd=?`,
      args: [lawd],
    });
    const norms = new Map<string, number>();
    for (const row of masters.rows) {
      const norm = String(row.apt_name_norm);
      norms.set(norm, (norms.get(norm) ?? 0) + 1);
    }
    for (const row of masters.rows) {
      const id = String(row.complex_id);
      const norm = String(row.apt_name_norm);
      if ((norms.get(norm) ?? 0) > 1) ambiguousNames.add(`${lawd}|${norm}`);
      identities.set(id, {
        complexId: id,
        lawdCd: lawd,
        bjdongCd: String(row.bjdong_cd),
        aptName: String(row.apt_name ?? norm),
        legalDongName: String(row.legal_dong_name ?? ""),
      });
      if ((norms.get(norm) ?? 0) === 1) byName.set(`${lawd}|${norm}`, id);
    }
    console.log(`masters ${lawd} ${masters.rows.length}`);
  }

  const canonical = new Map<string, Set<string>>();
  const points = new Map<string, SupplySalePoint[]>();
  for (const cohort of DECADE_COHORTS_V22) {
    canonical.set(cohort.key, new Set());
    points.set(cohort.key, []);
  }
  const sawTrade = new Set<string>();
  const unresolvedTrade = new Set<string>();
  const under10Complexes = new Set<string>();
  let ambiguousTrades = 0;
  let noSupplyTrades = 0;
  let under10Trades = 0;
  let mappedTrades = 0;

  const floorSupply = new Map<string, number>();
  const floorPath = "/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl";
  if (existsSync(floorPath)) {
    const rl = createInterface({ input: createReadStream(floorPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const row = JSON.parse(line) as {
        level: string;
        complexId: string;
        exclusiveCents: number;
        floor: string;
        buildingDong: string;
        supplyCents: number;
      };
      if (row.level === "EXACT_FLOOR" && !row.buildingDong && identities.has(row.complexId)) {
        floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
      }
    }
  }
  console.log(`floor keys ${floorSupply.size}`);

  for (const lawd of lawds) {
    const ids = [...identities.values()].filter((row) => row.lawdCd === lawd).map((row) => row.complexId);
    const supplies = new Map<string, number[]>();
    const exactKeys = new Set<string>();
    if (ids.length) {
      const supplyRows = await db.execute({
        sql: `SELECT complex_id, exclusive_cents, supply_area, status
              FROM apt_canonical_unit_types
              WHERE complex_id IN (${ids.map(() => "?").join(",")})
                AND supply_cents >= 0 AND status IN ('EXACT_SINGLE', 'AMBIGUOUS_MULTI')`,
        args: ids,
      });
      const exclusives = new Map<string, { exact: boolean; labels: Set<number> }>();
      for (const row of supplyRows.rows) {
        const id = String(row.complex_id);
        const key = `${id}|${num(row.exclusive_cents)}`;
        const supplyArea = num(row.supply_area);
        if (!(supplyArea > 0)) continue;
        const bucket = exclusives.get(key) ?? { exact: false, labels: new Set<number>() };
        const label = marketPyeongLabelInteger(supplyArea);
        if (label != null) bucket.labels.add(label);
        if (String(row.status) === "EXACT_SINGLE") {
          bucket.exact = true;
          exactKeys.add(key);
        }
        const list = supplies.get(key) ?? [];
        list.push(supplyArea);
        supplies.set(key, list);
        exclusives.set(key, bucket);
      }
      for (const [key, bucket] of exclusives) {
        if (bucket.labels.size !== 1) continue;
        const label = [...bucket.labels][0]!;
        const cohort = decadeCohortForLabel(label);
        if (!cohort) continue;
        canonical.get(cohort.key)!.add(key.slice(0, key.indexOf("|")));
      }
    }

    const tx = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, substr(deal_date,1,7) ym
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND year_month>=? AND year_month<=?
              AND deal_date<=? AND deal_amount>0 AND exclusive_area>0`,
      args: [lawd, FLOOR_YM, ASOF_YM, AS_OF],
    });
    for (const row of tx.rows) {
      const norm = String(row.apt_name_norm);
      if (ambiguousNames.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      const id = complexId ? identities.get(complexId) : undefined;
      if (!complexId || !id) continue;
      sawTrade.add(complexId);
      const exclusiveArea = Number(row.exclusive_area);
      const pair = `${complexId}|${exclusiveCents(exclusiveArea)}`;
      const floorHit = floorSupply.get(`${pair}|${Number(row.floor)}`);
      const areas = supplies.get(pair) ?? [];
      let supplyArea: number | null = null;
      let label: number | null = null;
      if (floorHit != null) {
        supplyArea = floorHit;
        label = marketPyeongLabelInteger(supplyArea);
      } else if (exactKeys.has(pair) && areas.length === 1) {
        supplyArea = areas[0]!;
        label = marketPyeongLabelInteger(supplyArea);
      } else {
        const labels = [...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((item): item is number => item != null))];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
        } else if (labels.length > 1) {
          ambiguousTrades += 1;
          unresolvedTrade.add(complexId);
          continue;
        } else {
          noSupplyTrades += 1;
          unresolvedTrade.add(complexId);
          continue;
        }
      }
      if (label == null || supplyArea == null || !(label > 0)) {
        noSupplyTrades += 1;
        unresolvedTrade.add(complexId);
        continue;
      }
      const cohort = decadeCohortForLabel(label);
      if (!cohort) {
        under10Trades += 1;
        under10Complexes.add(complexId);
        continue;
      }
      mappedTrades += 1;
      const dealAmount = Number(row.deal_amount);
      points.get(cohort.key)!.push({
        complexId,
        lawdCd: lawd,
        bjdongCd: id.bjdongCd,
        yearMonth: String(row.ym),
        pricePerSupplyPyeong: pricePerSupplyPyeong(dealAmount, supplyArea) ?? 0,
        pricePerMarketPyeong: dealAmount / label,
        marketPyeongLabel: label,
        dealAmount,
        exclusiveArea,
        supplyArea,
        supplyPyeong: exactSupplyPyeong(supplyArea),
      });
    }
    console.log(`trades ${lawd} rows=${tx.rows.length} mapped=${mappedTrades}`);
  }

  const coverage: Record<string, unknown> = {};
  let priceMismatch = 0;
  let complexMismatch = 0;
  let regionChanged = 0;
  let parityCompared = 0;
  let rowLoss = 0;
  const priceMismatchExamples: string[] = [];
  const complexMismatchExamples: string[] = [];
  const rowLossExamples: string[] = [];
  const pilotOut: Record<string, unknown> = {};
  let seoul5yDistribution: Record<string, unknown> | null = null;
  let jamsil: Record<string, unknown> = {};
  let smallArea: Record<string, unknown> | null = null;
  let largeArea: Record<string, unknown> | null = null;
  let duplicateKeys = 0;
  const invariantFailures: string[] = [];
  let invariantFailureCount = 0;
  function fail(message: string) {
    invariantFailureCount += 1;
    if (invariantFailures.length < 20) invariantFailures.push(message);
  }
  let totalRows = 0;
  let totalSlices = 0;
  const uniqueComplexes = new Set<string>();
  const insufficient = { DONG: 0, GU: 0, SEOUL: 0 };
  const gatePass = { DONG: 0, GU: 0, SEOUL: 0 };
  const bodiesDir = "/tmp/v23-bodies";
  mkdirSync(bodiesDir, { recursive: true });

  for (const cohort of DECADE_COHORTS_V22) {
    const started = Date.now();
    const built = buildPricePositionV23({
      cohort,
      points: points.get(cohort.key) ?? [],
      identities,
      cohortUniverse: canonical.get(cohort.key),
      transactionAsOf: AS_OF,
    });
    const seen = new Set<string>();
    let slices = 0;
    let dongPass = 0;
    let guPass = 0;
    let seoulPass = 0;
    let dongFail = 0;
    let guFail = 0;
    let seoulFail = 0;
    const reasons: Record<string, number> = {};
    for (const body of built.bodies) {
      if (seen.has(body.complexId)) duplicateKeys += 1;
      seen.add(body.complexId);
      uniqueComplexes.add(body.complexId);
      if (body.version !== PRICE_POSITION_V23_VERSION) fail(`${cohort.key} version`);
      if (body.methodologyFingerprint !== METHODOLOGY_FINGERPRINT_V23) fail(`${cohort.key} fingerprint`);
      if (body.areaBand !== cohort.key || body.cohortKey !== cohort.key || body.regionPyeongDecade !== cohort.label) {
        fail(`${cohort.key} cohort identity ${body.complexId}`);
      }
      const sliceLabels = Object.keys(body.complexExactByMarketLabel ?? {});
      if (!sliceLabels.length) fail(`${cohort.key} empty slices ${body.complexId}`);
      for (const label of sliceLabels) {
        const value = Number(label);
        if (!(value >= cohort.min && value < cohort.max)) fail(`${cohort.key} slice ${label}`);
      }
      slices += sliceLabels.length;
      for (const scope of ["DONG", "GU", "SEOUL"] as const) {
        const cell = body.priceLevel.find((row) => row.scope === scope);
        if (cell?.status === "ok") {
          if (scope === "DONG") dongPass += 1;
          if (scope === "GU") guPass += 1;
          if (scope === "SEOUL") seoulPass += 1;
        } else {
          if (scope === "DONG") dongFail += 1;
          if (scope === "GU") guFail += 1;
          if (scope === "SEOUL") seoulFail += 1;
          reasons[`${scope}_INSUFFICIENT`] = (reasons[`${scope}_INSUFFICIENT`] ?? 0) + 1;
        }
      }
    }
    totalRows += built.bodies.length;
    totalSlices += slices;
    gatePass.DONG += dongPass;
    gatePass.GU += guPass;
    gatePass.SEOUL += seoulPass;
    insufficient.DONG += dongFail;
    insufficient.GU += guFail;
    insufficient.SEOUL += seoulFail;
    const usable = new Set((points.get(cohort.key) ?? []).map((point) => point.complexId));
    coverage[cohort.label] = {
      deterministicComplexes: canonical.get(cohort.key)!.size,
      usableTradeComplexes: usable.size,
      rows: built.bodies.length,
      exactSlices: slices,
      dongPass,
      guPass,
      seoulPass,
      dongFail,
      guFail,
      seoulFail,
      reasons,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(`built ${cohort.label}`, coverage[cohort.label]);
    for (const body of built.bodies) {
      const gu = seoulGuName(identities.get(body.complexId)?.lawdCd ?? "") || "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.scope === "GU") cell.label = gu;
      }
    }
    const sink = createWriteStream(`${bodiesDir}/${cohort.key}.jsonl`);
    for (const body of built.bodies) {
      if (!sink.write(`${JSON.stringify(body)}\n`)) await once(sink, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      sink.on("error", reject);
      sink.end(() => resolve());
    });

    if (cohort.key === "10" && !smallArea) {
      const body = built.bodies.find((row) => row.status === "ok");
      if (body) smallArea = summarizeBody(body);
    }
    if ((cohort.key === "50" || cohort.key === "60" || cohort.key === "70") && !largeArea) {
      const body = built.bodies.find((row) => row.status === "ok");
      if (body) largeArea = summarizeBody(body);
    }
    for (const [name, id] of Object.entries(PILOTS)) {
      const body = built.bodies.find((row) => row.complexId === id);
      if (!body) continue;
      const list = (pilotOut[name] as unknown[]) ?? [];
      list.push(summarizeBody(body));
      pilotOut[name] = list;
    }

    const stored = await db.execute({
      sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
      args: [SNAP22, cohort.key],
    });
    const v23ById = new Map(built.bodies.map((body) => [body.complexId, body]));
    const v22Ids = new Set(stored.rows.map((row) => String(row.complex_id)));
    for (const id of v23ById.keys()) {
      if (!v22Ids.has(id)) rowLoss += 1;
    }
    for (const row of stored.rows) {
      const id = String(row.complex_id);
      const right = v23ById.get(id);
      if (!right) {
        rowLoss += 1;
        if (rowLossExamples.length < 8) rowLossExamples.push(`${cohort.key}|${id}`);
        continue;
      }
      parityCompared += 1;
      const left = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
      if (!priceLevelEqual(left, right)) {
        priceMismatch += 1;
        if (priceMismatchExamples.length < 8) priceMismatchExamples.push(`${cohort.key}|${id}`);
      }
      if (!complexTrendEqual(left, right)) {
        complexMismatch += 1;
        if (complexMismatchExamples.length < 8) complexMismatchExamples.push(`${cohort.key}|${id}`);
      }
      if (regionTrendChanged(left, right)) regionChanged += 1;
      if (cohort.key === "30" && id === JAMSIL) {
        const exact22 = applyExactComplexMarketLabel(left, 33, "exact");
        const exact23 = applyExactComplexMarketLabel(right, 33, "exact");
        const trend = (body: PricePositionBodyV21, scope: "COMPLEX" | "DONG" | "GU" | "SEOUL", horizon: (typeof TREND_HORIZONS_V21)[number]) =>
          body.trends[horizon].find((cell) => cell.scope === scope);
        jamsil = {
          complex1Y: exact23.trends["1Y"].find((cell) => cell.scope === "COMPLEX"),
          complex1Yv22: exact22.trends["1Y"].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null,
          dong1Y: trend(exact23, "DONG", "1Y"),
          gu1Y: trend(exact23, "GU", "1Y"),
          seoul1Y: trend(exact23, "SEOUL", "1Y"),
          seoul5Y: trend(exact23, "SEOUL", "5Y"),
          dong5Y: trend(exact23, "DONG", "5Y"),
          gu5Y: trend(exact23, "GU", "5Y"),
          sixMonthWindow: trend(exact23, "SEOUL", "6M"),
        };
      }
    }
    if (cohort.key === "30") {
      const referenceMonth = "2026-09";
      const window = resolveRegionWindowV23({
        referenceMonth,
        horizonShift: 60,
        historyFloor: "2021-07",
      });
      const tables = buildComplexMonthValues(points.get(cohort.key) ?? []);
      const changes: number[] = [];
      if (window) {
        for (const cells of tables.values()) {
          const current = pooledWindowMean(cells, window.currentStart, window.currentEnd, referenceMonth);
          const baseline = pooledWindowMean(cells, window.baselineStart, window.baselineEnd, referenceMonth);
          if (!current || !baseline) continue;
          const change = changePercentV2(current.mean, baseline.mean);
          if (change == null) continue;
          changes.push(change);
        }
      }
      changes.sort((a, b) => a - b);
      const nearest = (p: number) => {
        if (!changes.length) return null;
        return changes[Math.max(0, Math.ceil(p * changes.length) - 1)] ?? null;
      };
      seoul5yDistribution = {
        referenceMonth,
        n: changes.length,
        min: changes[0] ?? null,
        p10: nearest(0.1),
        p25: nearest(0.25),
        median: median(changes),
        p75: nearest(0.75),
        p90: nearest(0.9),
        max: changes.at(-1) ?? null,
        windowStatus: window?.status ?? null,
        length: window?.length ?? null,
        currentWindow: window ? `${window.currentStart}..${window.currentEnd}` : null,
        baselineWindow: window ? `${window.baselineStart}..${window.baselineEnd}` : null,
      };
    }
    points.set(cohort.key, []);
  }

  const withDecade = uniqueComplexes.size;
  let noTrade = 0;
  let unresolvedOnly = 0;
  let under10Only = 0;
  let noTradeNoLabel = 0;
  const anyCanonical = new Set<string>();
  for (const set of canonical.values()) for (const id of set) anyCanonical.add(id);
  for (const id of identities.keys()) {
    if (uniqueComplexes.has(id)) continue;
    if (anyCanonical.has(id)) noTrade += 1;
    else if (under10Complexes.has(id) && !unresolvedTrade.has(id)) under10Only += 1;
    else if (unresolvedTrade.has(id) || sawTrade.has(id)) unresolvedOnly += 1;
    else noTradeNoLabel += 1;
  }
  const explainedMissing = noTrade + unresolvedOnly + under10Only + noTradeNoLabel;
  const unknown = identities.size - withDecade - explainedMissing;

  const jamsilComplex1Y = (jamsil.complex1Y as { changePercent?: number } | undefined)?.changePercent;
  const seoul6 = jamsil.sixMonthWindow as { currentWindow?: string; baselineWindow?: string; windowStatus?: string } | undefined;
  const windowsValid =
    seoul6?.windowStatus === "FULL_WINDOW" &&
    seoul6.currentWindow === "2026-04..2026-09" &&
    seoul6.baselineWindow === "2025-10..2026-03";
  const invariantOk =
    duplicateKeys === 0 &&
    invariantFailureCount === 0 &&
    unknown === 0 &&
    rowLoss === 0 &&
    priceMismatch === 0 &&
    complexMismatch === 0 &&
    regionChanged > 0 &&
    jamsilComplex1Y === 0.91 &&
    windowsValid;
  const report = {
    apply: APPLY,
    snapshot: SNAP23,
    fingerprint: METHODOLOGY_FINGERPRINT_V23,
    before: { v2: beforeV2, v22: before22, v23: before23 },
    parity: {
      compared: parityCompared,
      priceMismatch,
      complexMismatch,
      regionChanged,
      rowLoss,
      priceMismatchExamples,
      complexMismatchExamples,
      rowLossExamples,
      windowsValid,
      jamsilComplex1Y,
    },
    mappedTrades,
    ambiguousTrades,
    noSupplyTrades,
    under10Trades,
    ambiguousNames: ambiguousNames.size,
    coverage,
    totals: {
      uniqueComplexes: uniqueComplexes.size,
      decadeRows: totalRows,
      exactSlices: totalSlices,
      insufficient,
      gatePass,
      duplicateKeys,
      invariantFailures,
      invariantFailureCount,
      missingExisting: 0,
    },
    jamsil,
    seoul5yDistribution,
    pilots: pilotOut,
    smallArea,
    largeArea,
    seoulMaster: identities.size,
    withDecade,
    withoutDecade: identities.size - withDecade,
    explainedMissing: {
      noTradeDespiteCanonicalLabel: noTrade,
      under10Only,
      unresolvedOrUnmappedTrade: unresolvedOnly,
      noTradeNoDecadeLabel: noTradeNoLabel,
    },
    unknown,
    invariantOk,
  };
  mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report));
  console.log(`report ${REPORT} invariantOk=${invariantOk} priceMismatch=${priceMismatch} complexMismatch=${complexMismatch} regionChanged=${regionChanged} rowLoss=${rowLoss} jamsil1Y=${jamsilComplex1Y}`);

  if (!invariantOk) {
    console.log("invariant failure; no write");
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    console.log("dry-run only");
    return;
  }

  const now = new Date().toISOString();
  let insertedBatches = 0;
  for (const cohort of DECADE_COHORTS_V22) {
    const pending: PricePositionBodyV21[] = [];
    const rl = createInterface({ input: createReadStream(`${bodiesDir}/${cohort.key}.jsonl`), crlfDelay: Infinity });
    const flush = async () => {
      if (!pending.length) return;
      const slice = pending.splice(0, pending.length).map((body) => ({
        sql: `INSERT INTO complex_region_price_position (
                snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
                reference_month, status, payload_json, calculated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
        args: [
          SNAP23,
          body.complexId,
          body.areaBand,
          body.transactionAsOf,
          body.areaBandVersion,
          body.referenceMonth,
          body.status,
          JSON.stringify(body),
          now,
        ],
      }));
      let last: unknown = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await db.batch(slice, "write");
          last = null;
          break;
        } catch (error) {
          last = error;
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (last) throw last;
      insertedBatches += 1;
    };
    for await (const line of rl) {
      if (!line) continue;
      pending.push(JSON.parse(line) as PricePositionBodyV21);
      if (pending.length >= BATCH) await flush();
    }
    await flush();
    console.log(`inserted cohort ${cohort.key}`);
  }
  const after23 = await countSnap(db, SNAP23);
  const after22 = await countSnap(db, SNAP22);
  const afterV2 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2|2026-09-17"] })).rows[0]?.n,
  );
  const after21 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: ["price-position-v2.1|2026-09-17"] })).rows[0]?.n,
  );
  const delta = {
    v23Rows: after23.rows - before23.rows,
    v22Rows: after22.rows - before22.rows,
    v21Rows: after21 - beforeV21,
    v2Rows: afterV2 - beforeV2,
    after23,
    batches: insertedBatches,
  };
  writeFileSync(REPORT, JSON.stringify({ ...report, delta }));
  console.log("delta", delta);
  if (delta.v22Rows !== 0 || delta.v21Rows !== 0 || delta.v2Rows !== 0) {
    throw new Error("unrelated snapshot changed");
  }
}

function summarizeBody(body: PricePositionBodyV21) {
  const price = (scope: "COMPLEX" | "DONG" | "GU" | "SEOUL") => body.priceLevel.find((cell) => cell.scope === scope);
  return {
    complexId: body.complexId,
    aptName: body.aptName,
    decade: body.regionPyeongDecade,
    status: body.status,
    referenceMonth: body.referenceMonth,
    slices: Object.keys(body.complexExactByMarketLabel ?? {}),
    complex: price("COMPLEX")?.meanPricePerSupplyPyeong ?? null,
    dong: price("DONG")?.status,
    dongN: price("DONG")?.contributingComplexCount ?? null,
    gu: price("GU")?.status,
    seoul: price("SEOUL")?.status,
    trend6: body.trends["6M"].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
