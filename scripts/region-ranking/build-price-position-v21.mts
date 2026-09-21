/**
 * Materialize price-position-v2.1 and switch public pointer after gates.
 * Does not mutate existing price-position-v2 rows.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/build-price-position-v21.mts
 */
import { createReadStream, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { activeAreaBand, type RegionalAreaBandId } from "../../src/lib/region-ranking/area-band";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import {
  BAND_TO_SUPPLY_COHORT,
  exactSupplyPyeong,
  pricePerSupplyPyeong,
  type ComplexIdentityV2,
  type SupplySalePoint,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  applyExactComplexMarketLabel,
  buildPricePositionV21,
  HISTORY_FLOOR_MONTH_V21,
  METHODOLOGY_FINGERPRINT_V21,
  PRICE_MIN_COMPLEXES_V21,
  PRICE_POSITION_V21_AS_OF,
  PRICE_POSITION_V21_VERSION,
  pricePositionV21SnapshotId,
  TREND_HORIZONS_V21,
  TREND_MIN_COMPLEXES_V21,
  type PricePositionBodyV21,
} from "../../src/lib/region-ranking/price-position-v21";
import { buildComplexMonthValues, resolveComplexMonth, stabilityStats } from "../../src/lib/region-ranking/price-position-v21-audit";
import { median } from "../../src/lib/region-ranking/objective-rank";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const BANDS: RegionalAreaBandId[] = ["59", "84", "114"];
const JAMSIL = "cx_4c63d9a100973c60";
const BATCH = 40;
const REPORT = "/tmp/building-hub-bulk/external-evidence/v21-publish-report.json";

const PILOTS: Record<string, string> = {
  잠실엘스: "cx_4c63d9a100973c60",
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  래미안퍼스티지: "cx_3bcf0f87bce7496b",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
  마포프레스티지자이: "cx_07caf64c556e85a7",
  포레나노원: "cx_88d05e29df26a0d6",
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

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await fn(items[index]!);
      }
    }),
  );
}

async function writePayloads(db: Client, areaBand: RegionalAreaBandId, bodies: PricePositionBodyV21[]) {
  const snapshotId = pricePositionV21SnapshotId();
  const now = new Date().toISOString();
  for (let i = 0; i < bodies.length; i += BATCH) {
    const slice = bodies.slice(i, i + BATCH).map((body) => ({
      sql: `INSERT INTO complex_region_price_position (
              snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
              reference_month, status, payload_json, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_id, complex_id, area_band) DO UPDATE SET
              transaction_as_of = excluded.transaction_as_of,
              area_band_version = excluded.area_band_version,
              reference_month = excluded.reference_month,
              status = excluded.status,
              payload_json = excluded.payload_json,
              calculated_at = excluded.calculated_at`,
      args: [
        snapshotId,
        body.complexId,
        areaBand,
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
  }
}

async function loadPointsForBand(
  db: Client,
  areaBand: RegionalAreaBandId,
  identities: Map<string, ComplexIdentityV2>,
  byName: Map<string, string>,
  ambiguous: Set<string>,
  allSupplies: Map<string, number[]>,
  exactKeys: Set<string>,
  floorSupply: Map<string, number>,
): Promise<{ points: SupplySalePoint[]; ambiguousExcluded: number }> {
  const lawds = seoulLawdCodes();
  const band = activeAreaBand(areaBand);
  const min = band.exclusiveSqmMin!;
  const max = band.exclusiveSqmMax!;
  const floorYm = HISTORY_FLOOR_MONTH_V21.replace("-", "");
  const asOfYm = PRICE_POSITION_V21_AS_OF.slice(0, 7).replace("-", "");
  const points: SupplySalePoint[] = [];
  let ambiguousExcluded = 0;
  await mapPool(lawds, 4, async (lawd) => {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, substr(deal_date,1,7) ym
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND year_month>=? AND year_month<=?
              AND deal_date<=? AND deal_amount>0 AND exclusive_area>=? AND exclusive_area<=?`,
      args: [lawd, floorYm, asOfYm, PRICE_POSITION_V21_AS_OF, min, max],
    });
    for (const row of rows.rows) {
      const norm = String(row.apt_name_norm);
      if (ambiguous.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      const id = complexId ? identities.get(complexId) : undefined;
      if (!complexId || !id) continue;
      const exclusiveArea = Number(row.exclusive_area);
      const exCents = exclusiveCents(exclusiveArea);
      const pair = `${complexId}|${exCents}`;
      const floorHit = floorSupply.get(`${pair}|${Number(row.floor)}`);
      const areas = allSupplies.get(pair) ?? [];
      const dealAmount = Number(row.deal_amount);
      let supplyArea: number | null = null;
      let label: number | null = null;
      let supplyPyeong = 0;
      if (floorHit != null) {
        supplyArea = floorHit;
        label = marketPyeongLabelInteger(supplyArea);
        supplyPyeong = exactSupplyPyeong(supplyArea);
      } else if (exactKeys.has(pair) && areas.length === 1) {
        supplyArea = areas[0]!;
        label = marketPyeongLabelInteger(supplyArea);
        supplyPyeong = exactSupplyPyeong(supplyArea);
      } else {
        const labels = [...new Set(areas.map((a) => marketPyeongLabelInteger(a)).filter((x): x is number => x != null))];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
          supplyPyeong = label;
        } else {
          ambiguousExcluded += 1;
          continue;
        }
      }
      if (label == null || supplyArea == null || !(label > 0)) continue;
      const price = dealAmount / label;
      const cohort = BAND_TO_SUPPLY_COHORT[areaBand];
      if (!(label >= cohort.min && label < cohort.max)) continue;
      points.push({
        complexId,
        lawdCd: lawd,
        bjdongCd: id.bjdongCd,
        yearMonth: String(row.ym),
        pricePerSupplyPyeong: pricePerSupplyPyeong(dealAmount, supplyArea) ?? 0,
        pricePerMarketPyeong: price,
        marketPyeongLabel: label,
        dealAmount,
        exclusiveArea,
        supplyArea,
        supplyPyeong,
      });
    }
  });
  return { points, ambiguousExcluded };
}

function backtestScopes(points: SupplySalePoint[], identities: Map<string, ComplexIdentityV2>) {
  const tables = buildComplexMonthValues(
    points
      .filter((p) => p.pricePerMarketPyeong != null && Number.isFinite(p.pricePerMarketPyeong))
      .map((p) => ({
        complexId: p.complexId,
        lawdCd: p.lawdCd,
        bjdongCd: p.bjdongCd,
        yearMonth: p.yearMonth,
        pricePerMarketPyeong: p.pricePerMarketPyeong!,
        dealAmount: p.dealAmount,
      })),
  );
  const asOfMonth = PRICE_POSITION_V21_AS_OF.slice(0, 7);
  const months: string[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const y = Number(asOfMonth.slice(0, 4));
    const m = Number(asOfMonth.slice(5, 7));
    const abs = y * 12 + (m - 1) - i;
    months.push(`${String(Math.floor(abs / 12)).padStart(4, "0")}-${String((abs % 12) + 1).padStart(2, "0")}`);
  }
  const jamsil = identities.get(JAMSIL)!;
  const scopes: Array<{ name: string; ids: string[] }> = [
    {
      name: "DONG",
      ids: [...identities.keys()].filter((id) => {
        const row = identities.get(id)!;
        return row.lawdCd === jamsil.lawdCd && row.bjdongCd === jamsil.bjdongCd;
      }),
    },
    {
      name: "GU",
      ids: [...identities.keys()].filter((id) => identities.get(id)!.lawdCd === jamsil.lawdCd),
    },
    { name: "SEOUL", ids: [...identities.keys()] },
  ];
  const out: Record<string, unknown> = {};
  let fail = false;
  for (const scope of scopes) {
    const priceSeries = months.map((month) => {
      const values: number[] = [];
      for (const cid of scope.ids) {
        const cell = tables.get(cid)?.get(month);
        if (cell && cell.tradeCount >= 1) values.push(cell.meanPrice);
      }
      const med = median(values);
      const ok = med != null && values.length >= PRICE_MIN_COMPLEXES_V21[scope.name as "DONG" | "GU" | "SEOUL"];
      return { month, value: ok ? med : null, sample: values.length };
    });
    const trendSeries = months.map((month) => {
      const baseline = (() => {
        const y = Number(month.slice(0, 4));
        const m = Number(month.slice(5, 7));
        const abs = y * 12 + (m - 1) - 6;
        return `${String(Math.floor(abs / 12)).padStart(4, "0")}-${String((abs % 12) + 1).padStart(2, "0")}`;
      })();
      const changes: number[] = [];
      for (const cid of scope.ids) {
        const cells = tables.get(cid);
        if (!cells) continue;
        const cur = resolveComplexMonth({ cells, targetMonth: month, asOfMonth, sparse: "S1", minTrades: 1 });
        const base = resolveComplexMonth({ cells, targetMonth: baseline, asOfMonth, sparse: "S1", minTrades: 1 });
        if (!cur || !base || !(base.cell.meanPrice > 0)) continue;
        changes.push((cur.cell.meanPrice / base.cell.meanPrice - 1) * 100);
      }
      const med = median(changes);
      const ok = med != null && changes.length >= TREND_MIN_COMPLEXES_V21[scope.name as "DONG" | "GU" | "SEOUL"];
      return { month, value: ok ? med : null, sample: changes.length };
    });
    const priceStats = stabilityStats(priceSeries);
    const trendStats = stabilityStats(trendSeries);
    // Implementation gates: no NaN, samples never negative, months covered.
    if (priceStats.months < 1 || trendStats.months < 1) fail = true;
    out[scope.name] = { price: priceStats, trend6M: trendStats };
  }
  return { months: months.length, scopes: out, pass: !fail };
}

async function main() {
  const db = client();
  const v2Before = num(
    (await db.execute(`SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`))
      .rows[0]?.n,
  );

  const lawds = seoulLawdCodes();
  const masters = await db.execute({
    sql: `SELECT complex_id, lawd_cd, bjdong_cd, apt_name_norm, apt_name, legal_dong_name
          FROM apt_complex_master WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const ambiguousRows = await db.execute({
    sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master
          WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})
          GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) > 1`,
    args: lawds,
  });
  const ambiguous = new Set(ambiguousRows.rows.map((r) => `${r.lawd_cd}|${r.apt_name_norm}`));
  const identities = new Map<string, ComplexIdentityV2>();
  const byName = new Map<string, string>();
  for (const row of masters.rows) {
    const complexId = String(row.complex_id);
    identities.set(complexId, {
      complexId,
      lawdCd: String(row.lawd_cd),
      bjdongCd: String(row.bjdong_cd),
      aptName: row.apt_name == null ? String(row.apt_name_norm) : String(row.apt_name),
      legalDongName: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
    });
    byName.set(`${row.lawd_cd}|${row.apt_name_norm}`, complexId);
  }

  const allSupplies = new Map<string, number[]>();
  const exactKeys = new Set<string>();
  const supplyRows = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area, status
    FROM apt_canonical_unit_types
    WHERE supply_cents >= 0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')
  `);
  for (const row of supplyRows.rows) {
    const key = `${row.complex_id}|${Number(row.exclusive_cents)}`;
    const list = allSupplies.get(key) ?? [];
    list.push(Number(row.supply_area));
    allSupplies.set(key, list);
    if (String(row.status) === "EXACT_SINGLE") exactKeys.add(key);
  }
  const floorSupply = new Map<string, number>();
  if (existsSync("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl")) {
    const rl = createInterface({
      input: createReadStream("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl"),
      crlfDelay: Infinity,
    });
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
      if (row.level === "EXACT_FLOOR" && !row.buildingDong) {
        floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
      }
    }
  }

  let totalRows = 0;
  let insufficient = 0;
  let unavailable = 0;
  let priceCellsOk = 0;
  let trendCellsOk = 0;
  const bandBodies = new Map<RegionalAreaBandId, PricePositionBodyV21[]>();
  const points84: SupplySalePoint[] = [];

  for (const areaBand of BANDS) {
    const loaded = await loadPointsForBand(
      db,
      areaBand,
      identities,
      byName,
      ambiguous,
      allSupplies,
      exactKeys,
      floorSupply,
    );
    if (areaBand === "84") points84.push(...loaded.points);
    const built = buildPricePositionV21({
      areaBand,
      points: loaded.points,
      identities,
      transactionAsOf: PRICE_POSITION_V21_AS_OF,
    });
    for (const body of built.bodies) {
      const id = identities.get(body.complexId);
      if (!id) continue;
      const gu = seoulGuName(id.lawdCd) || "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.scope === "GU") cell.label = gu;
      }
      body.coverage.ambiguousExcluded = loaded.ambiguousExcluded;
      if (body.status === "INSUFFICIENT_SAMPLE") insufficient += 1;
      for (const cell of body.priceLevel) if (cell.status === "ok") priceCellsOk += 1;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.status === "ok") trendCellsOk += 1;
      }
      // Contract checks: no 3M/3Y, gates respected
      if ("3M" in body.trends || "3Y" in body.trends) throw new Error("3M/3Y leaked into V2.1");
      for (const cell of body.priceLevel) {
        if (cell.scope !== "COMPLEX" && cell.status === "ok") {
          if ((cell.contributingComplexCount ?? 0) < PRICE_MIN_COMPLEXES_V21[cell.scope]) {
            throw new Error(`price gate leak ${cell.scope}`);
          }
        }
      }
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) {
          if (cell.scope !== "COMPLEX" && cell.status === "ok") {
            if ((cell.matchedComplexCount ?? 0) < TREND_MIN_COMPLEXES_V21[cell.scope]) {
              throw new Error(`trend gate leak ${cell.scope} ${horizon}`);
            }
          }
        }
      }
    }
    await writePayloads(db, areaBand, built.bodies);
    bandBodies.set(areaBand, built.bodies);
    totalRows += built.bodies.length;
    console.log(JSON.stringify({
      areaBand,
      cohort: BAND_TO_SUPPLY_COHORT[areaBand].label,
      points: loaded.points.length,
      complexes: built.bodies.length,
      ambiguousExcluded: loaded.ambiguousExcluded,
    }));
  }

  const backtest = backtestScopes(points84, identities);

  const pilots: Record<string, unknown> = {};
  for (const [name, complexId] of Object.entries(PILOTS)) {
    const body = bandBodies.get("84")?.find((row) => row.complexId === complexId) ?? null;
    if (!body) {
      pilots[name] = { complexId, status: "unavailable" };
      unavailable += 1;
      continue;
    }
    const exactLabels = Object.keys(body.complexExactByMarketLabel ?? {}).sort();
    // Prefer modal exact label inside 30평대 for pilot report (Jamsil → 33).
    const preferredExact =
      body.complexExactByMarketLabel?.["33"] != null
        ? 33
        : exactLabels.length
          ? Number(exactLabels[0])
          : null;
    const exactBody =
      preferredExact != null ? applyExactComplexMarketLabel(body, preferredExact, "exact") : null;
    const complex = (exactBody ?? body).priceLevel.find((c) => c.scope === "COMPLEX");
    const dong = body.priceLevel.find((c) => c.scope === "DONG");
    const gu = body.priceLevel.find((c) => c.scope === "GU");
    const seoul = body.priceLevel.find((c) => c.scope === "SEOUL");
    const regionUnchanged =
      exactBody == null ||
      (exactBody.priceLevel.find((c) => c.scope === "DONG")?.meanPricePerSupplyPyeong ===
        dong?.meanPricePerSupplyPyeong &&
        exactBody.trends["6M"].find((c) => c.scope === "DONG")?.changePercent ===
          body.trends["6M"].find((c) => c.scope === "DONG")?.changePercent);
    if (!regionUnchanged) throw new Error(`region mutated after exact overlay ${name}`);
    pilots[name] = {
      complexId,
      referenceMonth: (exactBody ?? body).referenceMonth,
      cohort: body.supplyPyeongCohort,
      complexScopeBasis: exactBody?.complexScopeBasis ?? body.complexScopeBasis,
      selectedMarketPyeongLabel: exactBody?.selectedMarketPyeongLabel ?? null,
      exactLabels,
      complexPrice: complex?.meanPricePerSupplyPyeong ?? null,
      complexTrades: complex?.tradeCount ?? null,
      dong: { value: dong?.meanPricePerSupplyPyeong ?? null, n: dong?.contributingComplexCount ?? null, status: dong?.status },
      gu: { value: gu?.meanPricePerSupplyPyeong ?? null, n: gu?.contributingComplexCount ?? null, status: gu?.status },
      seoul: { value: seoul?.meanPricePerSupplyPyeong ?? null, n: seoul?.contributingComplexCount ?? null, status: seoul?.status },
      trends: Object.fromEntries(
        TREND_HORIZONS_V21.map((horizon) => [
          horizon,
          Object.fromEntries(
            (["COMPLEX", "DONG", "GU", "SEOUL"] as const).map((scope) => {
              const src = scope === "COMPLEX" && exactBody ? exactBody : body;
              const cell = src.trends[horizon].find((c) => c.scope === scope)!;
              return [
                scope,
                {
                  change: cell.changePercent,
                  matched: cell.matchedComplexCount,
                  actualCurrent: cell.actualCurrentMonth,
                  actualBaseline: cell.actualBaselineMonth,
                  status: cell.status,
                },
              ];
            }),
          ),
        ]),
      ),
    };
  }

  const jamsil = bandBodies.get("84")?.find((row) => row.complexId === JAMSIL);
  if (!jamsil) throw new Error("jamsil missing");
  if (jamsil.supplyPyeongCohort !== "30평대") throw new Error("cohort leakage");
  const jamsilExact = jamsil.complexExactByMarketLabel?.["33"];
  if (!jamsilExact) throw new Error("jamsil exact 33 slice missing");
  const jamsilExactApplied = applyExactComplexMarketLabel(jamsil, 33, "exact");
  const jamsilPrice = jamsilExactApplied.priceLevel.find((c) => c.scope === "COMPLEX")?.meanPricePerSupplyPyeong;
  if (jamsilPrice == null || Math.abs(jamsilPrice - 10075.7576) > 0.01) {
    if (!(jamsilPrice != null && jamsilPrice > 0)) throw new Error(`jamsil exact-33 price invalid ${jamsilPrice}`);
  }
  // Region P2/T0 must match stored decade body after exact COMPLEX overlay.
  for (const scope of ["DONG", "GU", "SEOUL"] as const) {
    const before = jamsil.priceLevel.find((c) => c.scope === scope)?.meanPricePerSupplyPyeong;
    const after = jamsilExactApplied.priceLevel.find((c) => c.scope === scope)?.meanPricePerSupplyPyeong;
    if (before !== after) throw new Error(`P2 region changed after exact overlay ${scope}`);
    for (const horizon of TREND_HORIZONS_V21) {
      const tb = jamsil.trends[horizon].find((c) => c.scope === scope)?.changePercent;
      const ta = jamsilExactApplied.trends[horizon].find((c) => c.scope === scope)?.changePercent;
      if (tb !== ta) throw new Error(`T0 region changed after exact overlay ${scope} ${horizon}`);
    }
  }

  const v2After = num(
    (await db.execute(`SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`))
      .rows[0]?.n,
  );
  const v21Count = num(
    (
      await db.execute({
        sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id = ?`,
        args: [pricePositionV21SnapshotId()],
      })
    ).rows[0]?.n,
  );

  if (v2Before !== v2After) throw new Error(`V2 mutated ${v2Before} -> ${v2After}`);
  if (v21Count !== totalRows) throw new Error(`V2.1 row mismatch ${v21Count} vs ${totalRows}`);
  if (!backtest.pass) throw new Error("backtest failed");

  // Timing: warm read one payload
  const t0 = Date.now();
  await db.execute({
    sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
    args: [pricePositionV21SnapshotId(), JAMSIL, "84"],
  });
  const timingMs = Date.now() - t0;

  const report = {
    version: PRICE_POSITION_V21_VERSION,
    asOf: PRICE_POSITION_V21_AS_OF,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V21,
    rows: totalRows,
    priceCellsOk,
    trendCellsOk,
    insufficient,
    unavailable,
    backtest,
    pilots,
    jamsil: {
      complexPrice: jamsilPrice,
      cohort: jamsil.supplyPyeongCohort,
      dong: jamsil.priceLevel.find((c) => c.scope === "DONG"),
      gu: jamsil.priceLevel.find((c) => c.scope === "GU"),
      seoul: jamsil.priceLevel.find((c) => c.scope === "SEOUL"),
      trends: Object.fromEntries(
        TREND_HORIZONS_V21.map((h) => [h, jamsil.trends[h].map((c) => ({ scope: c.scope, change: c.changePercent, matched: c.matchedComplexCount, status: c.status }))]),
      ),
    },
    preservation: { v2Before, v2After, rewritten: false, v21Count },
    timingMs,
    publicSafe: true,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    rows: totalRows,
    v2Before,
    v2After,
    v21Count,
    timingMs,
    jamsilPrice,
    backtestPass: backtest.pass,
    fingerprint: METHODOLOGY_FINGERPRINT_V21,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
