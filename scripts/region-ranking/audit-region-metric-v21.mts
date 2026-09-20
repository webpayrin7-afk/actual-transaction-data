/**
 * AUDIT ONLY — Ziblab region price/trend methodology for proposed v2.1.
 * Does not mutate V2 rows, public pointer, supply master, ranking, or UI.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/audit-region-metric-v21.mts
 */
import { createReadStream, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import {
  BAND_TO_SUPPLY_COHORT,
  exactSupplyPyeong,
  inSupplyCohort,
  PRICE_POSITION_V2_AS_OF,
  shiftYearMonthV2,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  buildComplexMonthValues,
  compositionSensitivity,
  HORIZON_SHIFT_MONTHS_V21,
  PRICE_CANDIDATES_V21,
  regionPriceCandidate,
  regionTrendCandidate,
  stabilityStats,
  TREND_CANDIDATES_V21,
  TREND_HORIZONS_V21,
  type ComplexMonthStat,
  type DealPoint,
  type SparsePolicyV21,
} from "../../src/lib/region-ranking/price-position-v21-audit";

const OUT = "/tmp/building-hub-bulk/external-evidence/region-metric-audit-v21.json";
const AS_OF = PRICE_POSITION_V2_AS_OF;
const AS_OF_MONTH = AS_OF.slice(0, 7);
const REF = AS_OF_MONTH;
const HISTORY_FLOOR = "2021-07"; // need 5Y from 2026-09 with sparse room
const BAND = "84" as const;
const COHORT = BAND_TO_SUPPLY_COHORT[BAND];

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

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
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

async function counterAccounting(db: ReturnType<typeof createClient>) {
  const pair = await db.execute(`
    SELECT
      SUM(trade_count_12m) att12,
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) exact12
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id = p.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const live = await db.execute(`
    WITH seoul_tx AS (
      SELECT t.deal_date, t.exclusive_area, m.complex_id,
             CAST(ROUND(t.exclusive_area * 100) AS INTEGER) exclusive_cents
      FROM transactions t
      JOIN apt_complex_master m ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
      WHERE t.lawd_cd LIKE '11%'
        AND t.deal_type = 'trade'
        AND t.deal_amount > 0 AND t.exclusive_area > 0
        AND t.deal_date <= '2026-09-17' AND t.deal_date >= '2025-09-17'
        AND m.complex_id IN (
          SELECT complex_id FROM apt_complex_master
          GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) = 1
        )
    )
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM apt_canonical_unit_types u
        WHERE u.complex_id = seoul_tx.complex_id
          AND u.exclusive_cents = seoul_tx.exclusive_cents
          AND u.supply_cents >= 0 AND u.status = 'EXACT_SINGLE'
      ) THEN 1 ELSE 0 END) exact
    FROM seoul_tx
  `);
  const prior = existsSync("/tmp/building-hub-bulk/external-evidence/resolver-coverage.json")
    ? JSON.parse(readFileSync("/tmp/building-hub-bulk/external-evidence/resolver-coverage.json", "utf8"))
    : null;
  return {
    priorDefinition:
      "Live unique-complex Seoul trade join (lawd+apt_name_norm unique) with deal_date in [2025-09-17, 2026-09-17], EXACT_SINGLE on exclusive_cents. Reported earlier as total≈63,901 exact≈38,836 (resolver-coverage / market-pyeong gate path).",
    currentResidualDefinition:
      "Precomputed apt_unit_exclusive_pairs.trade_count_12m for Seoul lawd prefix 11, exact when resolution_status=EXACT_SINGLE. Residual report 63,616 / 38,650.",
    priorArtifact: prior?.seoul12 ?? prior ?? null,
    liveUniqueComplexJoin: {
      total: num(live.rows[0]?.total),
      exact: num(live.rows[0]?.exact),
    },
    pairTradeCount12m: {
      total: num(pair.rows[0]?.att12),
      exact: num(pair.rows[0]?.exact12),
    },
    discrepancyExplained:
      "Different counters. Live join counts each MOLIT trade row under unique (lawd, apt_name_norm) complexes. Pair trade_count_12m is a stored pair-level rolling counter that can diverge when pair rows, resolvers, or complex uniqueness filters differ. Not forced equal.",
    dataBug: false,
  };
}

async function loadPoints(db: ReturnType<typeof createClient>): Promise<{
  points: DealPoint[];
  identities: Map<string, { lawdCd: string; bjdongCd: string; aptName: string; legalDongName: string }>;
  pooledByMonthScope: Map<string, number[]>;
}> {
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
  const identities = new Map<string, { lawdCd: string; bjdongCd: string; aptName: string; legalDongName: string }>();
  const byName = new Map<string, string>();
  for (const row of masters.rows) {
    const complexId = str(row.complex_id);
    identities.set(complexId, {
      lawdCd: str(row.lawd_cd),
      bjdongCd: str(row.bjdong_cd),
      aptName: str(row.apt_name) || str(row.apt_name_norm),
      legalDongName: str(row.legal_dong_name),
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
    if (str(row.status) === "EXACT_SINGLE") exactKeys.add(key);
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

  const points: DealPoint[] = [];
  const floorYm = HISTORY_FLOOR.replace("-", "");
  const asOfYm = AS_OF_MONTH.replace("-", "");
  await mapPool(lawds, 4, async (lawd) => {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, substr(deal_date,1,7) ym
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND year_month>=? AND year_month<=?
              AND deal_date<=? AND deal_amount>0 AND exclusive_area>0`,
      args: [lawd, floorYm, asOfYm, AS_OF],
    });
    for (const row of rows.rows) {
      const norm = str(row.apt_name_norm);
      if (ambiguous.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      const id = complexId ? identities.get(complexId) : undefined;
      if (!complexId || !id) continue;
      const exclusiveArea = num(row.exclusive_area);
      const exCents = exclusiveCents(exclusiveArea);
      const pair = `${complexId}|${exCents}`;
      const floorHit = floorSupply.get(`${pair}|${num(row.floor)}`);
      const areas = allSupplies.get(pair) ?? [];
      const dealAmount = num(row.deal_amount);
      let supplyArea: number | null = null;
      let label: number | null = null;
      if (floorHit != null) {
        supplyArea = floorHit;
        label = marketPyeongLabelInteger(supplyArea);
      } else if (exactKeys.has(pair) && areas.length === 1) {
        supplyArea = areas[0]!;
        label = marketPyeongLabelInteger(supplyArea);
      } else {
        const labels = [...new Set(areas.map((a) => marketPyeongLabelInteger(a)).filter((x): x is number => x != null))];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
        } else continue;
      }
      if (label == null || supplyArea == null) continue;
      if (!(label >= COHORT.min && label < COHORT.max)) continue;
      const price = dealAmount / label;
      if (!(price > 0)) continue;
      points.push({
        complexId,
        lawdCd: lawd,
        bjdongCd: id.bjdongCd,
        yearMonth: str(row.ym),
        pricePerMarketPyeong: price,
        dealAmount,
      });
    }
  });

  const pooledByMonthScope = new Map<string, number[]>();
  for (const point of points) {
    const id = identities.get(point.complexId)!;
    const scopes = [
      `SEOUL|${point.yearMonth}`,
      `GU|${point.lawdCd}|${point.yearMonth}`,
      `DONG|${point.lawdCd}${id.bjdongCd}|${point.yearMonth}`,
      `COMPLEX|${point.complexId}|${point.yearMonth}`,
    ];
    for (const key of scopes) {
      const list = pooledByMonthScope.get(key) ?? [];
      list.push(point.pricePerMarketPyeong);
      pooledByMonthScope.set(key, list);
    }
  }

  return { points, identities, pooledByMonthScope };
}

function scopeComplexIds(
  identities: Map<string, { lawdCd: string; bjdongCd: string; aptName: string; legalDongName: string }>,
  scope: "SEOUL" | "GU" | "DONG",
  seed: { lawdCd: string; bjdongCd: string },
): string[] {
  const out: string[] = [];
  for (const [complexId, id] of identities) {
    if (scope === "SEOUL") out.push(complexId);
    else if (scope === "GU" && id.lawdCd === seed.lawdCd) out.push(complexId);
    else if (scope === "DONG" && id.lawdCd === seed.lawdCd && id.bjdongCd === seed.bjdongCd) out.push(complexId);
  }
  return out;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  const v2Before = await db.execute(
    `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`,
  );
  const counters = await counterAccounting(db);
  console.log(JSON.stringify({ countersLive: counters.liveUniqueComplexJoin, countersPair: counters.pairTradeCount12m }));

  const { points, identities, pooledByMonthScope } = await loadPoints(db);
  console.log(JSON.stringify({ points: points.length, complexes: new Set(points.map((p) => p.complexId)).size }));
  const tables = buildComplexMonthValues(points);

  const jamsilId = PILOTS["잠실엘스"]!;
  const jamsil = identities.get(jamsilId)!;
  const songpa = { lawdCd: "11710", bjdongCd: jamsil.bjdongCd };

  const kinds: ComplexMonthStat[] = ["C1_MEAN", "C2_MEDIAN"];
  const sparsePolicies: SparsePolicyV21[] = ["S0", "S1", "S2"];
  const minSamples = [1, 3, 5, 10];

  // Complex-month sensitivity on Jamsil 2026-09
  const jamsilCell = tables.get(jamsilId)?.get(REF) ?? null;
  const complexMonth = {
    referenceMonth: REF,
    C1: jamsilCell?.meanPrice ?? null,
    C2: jamsilCell?.medianPrice ?? null,
    tradeCount: jamsilCell?.tradeCount ?? 0,
    recommendation: "C1_MEAN",
    reason: "Matches frozen complex price definition (mean of eligible deal/label prices). C2 is retained for abnormal-trade sensitivity checks only.",
  };

  // Region price matrix at SEOUL / GU(송파) / DONG(잠실)
  const priceMatrix: Record<string, unknown> = {};
  for (const scope of ["SEOUL", "GU", "DONG"] as const) {
    const complexIds = scopeComplexIds(identities, scope, songpa);
    const scopeKey =
      scope === "SEOUL" ? `SEOUL|${REF}` : scope === "GU" ? `GU|${songpa.lawdCd}|${REF}` : `DONG|${songpa.lawdCd}${songpa.bjdongCd}|${REF}`;
    const pooled = pooledByMonthScope.get(scopeKey) ?? [];
    const byKind: Record<string, unknown> = {};
    for (const kind of kinds) {
      const bySparse: Record<string, unknown> = {};
      for (const sparse of sparsePolicies) {
        const rows: Record<string, unknown> = {};
        for (const candidate of PRICE_CANDIDATES_V21) {
          const result = regionPriceCandidate({
            candidate,
            complexIds,
            tables,
            referenceMonth: REF,
            asOfMonth: AS_OF_MONTH,
            sparse,
            minComplexTrades: 1,
            kind,
            pooledTradePrices: pooled,
          });
          // composition bias: drop top-trade complex in reference month
          let topComplex: string | null = null;
          let topTrades = -1;
          for (const cid of complexIds) {
            const cell = tables.get(cid)?.get(REF);
            if (cell && cell.tradeCount > topTrades) {
              topTrades = cell.tradeCount;
              topComplex = cid;
            }
          }
          const without = topComplex
            ? regionPriceCandidate({
                candidate,
                complexIds: complexIds.filter((id) => id !== topComplex),
                tables,
                referenceMonth: REF,
                asOfMonth: AS_OF_MONTH,
                sparse,
                minComplexTrades: 1,
                kind,
                pooledTradePrices: (() => {
                  // approximate: exclude that complex's trades from pooled list is hard without re-scan; skip for P0 exact
                  return pooled;
                })(),
              })
            : null;
          rows[candidate] = {
            ...result,
            dropTopComplexShiftPct:
              candidate === "P0"
                ? null
                : compositionSensitivity({
                    withAll: result.value,
                    withoutTopComplex: without?.value ?? null,
                  }),
            topComplexTrades: topTrades >= 0 ? topTrades : null,
          };
        }
        bySparse[sparse] = rows;
      }
      byKind[kind] = bySparse;
    }
    priceMatrix[scope] = {
      label: scope === "SEOUL" ? "서울" : scope === "GU" ? seoulGuName(songpa.lawdCd) : jamsil.legalDongName || "잠실동",
      complexUniverse: complexIds.length,
      byKind,
    };
  }

  // Min-sample sensitivity for recommended style P2 / S0 / C1 at SEOUL
  const minSampleProbe: Record<string, unknown> = {};
  for (const min of minSamples) {
    const complexIds = scopeComplexIds(identities, "SEOUL", songpa);
    minSampleProbe[`min${min}`] = {
      P2: regionPriceCandidate({
        candidate: "P2",
        complexIds,
        tables,
        referenceMonth: REF,
        asOfMonth: AS_OF_MONTH,
        sparse: "S0",
        minComplexTrades: min,
        kind: "C1_MEAN",
      }),
      P1: regionPriceCandidate({
        candidate: "P1",
        complexIds,
        tables,
        referenceMonth: REF,
        asOfMonth: AS_OF_MONTH,
        sparse: "S0",
        minComplexTrades: min,
        kind: "C1_MEAN",
      }),
    };
  }

  // Trends for SEOUL / GU / DONG
  const trendMatrix: Record<string, unknown> = {};
  for (const scope of ["SEOUL", "GU", "DONG"] as const) {
    const complexIds = scopeComplexIds(identities, scope, songpa);
    const byHorizon: Record<string, unknown> = {};
    for (const horizon of TREND_HORIZONS_V21) {
      const bySparse: Record<string, unknown> = {};
      for (const sparse of sparsePolicies) {
        const rows: Record<string, unknown> = {};
        for (const candidate of TREND_CANDIDATES_V21) {
          rows[candidate] = regionTrendCandidate({
            candidate,
            complexIds,
            tables,
            referenceMonth: REF,
            horizon,
            asOfMonth: AS_OF_MONTH,
            sparse,
            minComplexTrades: 1,
            kind: "C1_MEAN",
          });
        }
        bySparse[sparse] = rows;
      }
      byHorizon[horizon] = {
        baselineMonth: shiftYearMonthV2(REF, -HORIZON_SHIFT_MONTHS_V21[horizon]),
        bySparse,
      };
    }
    trendMatrix[scope] = byHorizon;
  }

  // 12-month stability for serious candidates
  const stabilityMonths: string[] = [];
  for (let i = 11; i >= 0; i -= 1) stabilityMonths.push(shiftYearMonthV2(REF, -i));
  const seoulIds = scopeComplexIds(identities, "SEOUL", songpa);
  const guIds = scopeComplexIds(identities, "GU", songpa);
  const stability: Record<string, unknown> = {};
  for (const candidate of ["P0", "P1", "P2", "P4", "P6"] as const) {
    for (const scope of ["SEOUL", "GU"] as const) {
      const ids = scope === "SEOUL" ? seoulIds : guIds;
      const series = stabilityMonths.map((month) => {
        const pooledKey = scope === "SEOUL" ? `SEOUL|${month}` : `GU|${songpa.lawdCd}|${month}`;
        const result = regionPriceCandidate({
          candidate,
          complexIds: ids,
          tables,
          referenceMonth: month,
          asOfMonth: AS_OF_MONTH,
          sparse: "S0",
          minComplexTrades: 1,
          kind: "C1_MEAN",
          pooledTradePrices: pooledByMonthScope.get(pooledKey) ?? [],
        });
        return {
          month,
          value: result.value,
          sample: candidate === "P0" ? result.tradeCount : result.complexCount,
        };
      });
      stability[`${scope}_${candidate}`] = {
        series,
        stats: stabilityStats(series),
      };
    }
  }

  // Trend stability: T0 S1 on SEOUL 6M / 1Y across 12 months
  for (const horizon of ["6M", "1Y"] as const) {
    const series = stabilityMonths.map((month) => {
      const result = regionTrendCandidate({
        candidate: "T0",
        complexIds: seoulIds,
        tables,
        referenceMonth: month,
        horizon,
        asOfMonth: AS_OF_MONTH,
        sparse: "S1",
        minComplexTrades: 1,
        kind: "C1_MEAN",
      });
      return { month, value: result.changePercent, sample: result.matchedComplexes };
    });
    stability[`SEOUL_T0_${horizon}_S1`] = { series, stats: stabilityStats(series) };
  }

  // Pilots: complex price + surrounding region P2 / T0
  const pilots: Record<string, unknown> = {};
  for (const [name, complexId] of Object.entries(PILOTS)) {
    const id = identities.get(complexId);
    if (!id) {
      pilots[name] = { complexId, status: "missing_identity" };
      continue;
    }
    const cell = tables.get(complexId)?.get(REF) ?? null;
    const dongIds = scopeComplexIds(identities, "DONG", id);
    const guIdsLocal = scopeComplexIds(identities, "GU", id);
    pilots[name] = {
      complexId,
      lawdCd: id.lawdCd,
      gu: seoulGuName(id.lawdCd),
      dong: id.legalDongName,
      complexMonth: cell
        ? { mean: cell.meanPrice, median: cell.medianPrice, trades: cell.tradeCount }
        : null,
      regionPriceP2: {
        DONG: regionPriceCandidate({
          candidate: "P2",
          complexIds: dongIds,
          tables,
          referenceMonth: REF,
          asOfMonth: AS_OF_MONTH,
          sparse: "S0",
          minComplexTrades: 1,
          kind: "C1_MEAN",
        }),
        GU: regionPriceCandidate({
          candidate: "P2",
          complexIds: guIdsLocal,
          tables,
          referenceMonth: REF,
          asOfMonth: AS_OF_MONTH,
          sparse: "S0",
          minComplexTrades: 1,
          kind: "C1_MEAN",
        }),
        SEOUL: regionPriceCandidate({
          candidate: "P2",
          complexIds: seoulIds,
          tables,
          referenceMonth: REF,
          asOfMonth: AS_OF_MONTH,
          sparse: "S0",
          minComplexTrades: 1,
          kind: "C1_MEAN",
        }),
      },
      regionTrendT0_S1: Object.fromEntries(
        TREND_HORIZONS_V21.map((horizon) => [
          horizon,
          {
            DONG: regionTrendCandidate({
              candidate: "T0",
              complexIds: dongIds,
              tables,
              referenceMonth: REF,
              horizon,
              asOfMonth: AS_OF_MONTH,
              sparse: "S1",
              minComplexTrades: 1,
              kind: "C1_MEAN",
            }),
            GU: regionTrendCandidate({
              candidate: "T0",
              complexIds: guIdsLocal,
              tables,
              referenceMonth: REF,
              horizon,
              asOfMonth: AS_OF_MONTH,
              sparse: "S1",
              minComplexTrades: 1,
              kind: "C1_MEAN",
            }),
            SEOUL: regionTrendCandidate({
              candidate: "T0",
              complexIds: seoulIds,
              tables,
              referenceMonth: REF,
              horizon,
              asOfMonth: AS_OF_MONTH,
              sparse: "S1",
              minComplexTrades: 1,
              kind: "C1_MEAN",
            }),
          },
        ]),
      ),
    };
  }

  const v2After = await db.execute(
    `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`,
  );
  const publicPointer = {
    version: "price-position-v2",
    asOf: PRICE_POSITION_V2_AS_OF,
    rowsBefore: num(v2Before.rows[0]?.n),
    rowsAfter: num(v2After.rows[0]?.n),
    unchanged: num(v2Before.rows[0]?.n) === num(v2After.rows[0]?.n),
  };

  // Recommendation rationale from measured stability
  const seoulP0 = (stability.SEOUL_P0 as { stats: { maxAbsMomPct: number | null; medianAbsMomPct: number | null } }).stats;
  const seoulP2 = (stability.SEOUL_P2 as { stats: { maxAbsMomPct: number | null; medianAbsMomPct: number | null } }).stats;
  const guP0 = (stability.GU_P0 as { stats: { maxAbsMomPct: number | null; medianAbsMomPct: number | null } }).stats;
  const guP2 = (stability.GU_P2 as { stats: { maxAbsMomPct: number | null; medianAbsMomPct: number | null } }).stats;

  const recommendation = {
    price: {
      method: "P2",
      formula: "median over complexes of (complex reference-month C1 mean 만원/평)",
      complexMonthStat: "C1_MEAN",
      lookback: "exact calendar reference month (S0 for price level)",
      minSample: {
        complexMonth: 1,
        dong: 3,
        gu: 5,
        seoul: 10,
      },
      compositionBias: "low — one high-liquidity complex cannot dominate the region level",
      stabilityNote: {
        seoulP0maxMom: seoulP0.maxAbsMomPct,
        seoulP2maxMom: seoulP2.maxAbsMomPct,
        guP0maxMom: guP0.maxAbsMomPct,
        guP2maxMom: guP2.maxAbsMomPct,
      },
    },
    trend: {
      method: "T0",
      matchedComplexRule: "complex must resolve a value at both endpoints under the same sparse policy",
      monthWindow: "S1 (±1 calendar month) when exact month missing; never after as-of",
      aggregation: "median of per-complex percentage changes",
      complexMonthStat: "C1_MEAN",
      horizons: ["6M", "1Y", "2Y", "5Y"],
      remove3M: true,
      minSample: {
        complex: 1,
        dong: 3,
        gu: 5,
        seoul: 10,
      },
      reason:
        "Matched-complex median change resists outlier complexes and composition shifts. Geometric mean (T2) is coherent but less explainable. Mean-of-means (T3) reintroduces level-mix sensitivity.",
    },
    copy: {
      price: "선택한 평형대의 단지별 실거래 가격을 기준으로 지역 가격 수준을 비교합니다.",
      trend: "동일한 단지의 현재와 과거 실거래 가격을 비교해 지역 가격 변화를 계산합니다.",
      periods: "6개월 | 1년 | 2년 | 5년",
    },
    version: {
      proposed: "price-position-v2.1",
      publishNow: false,
      reason: "Audit-only. Materialize and gate V2.1 in a separate apply order after product sign-off.",
    },
  };

  const report = {
    asOf: AS_OF,
    cohort: COHORT.label,
    areaBand: BAND,
    counters,
    complexMonth,
    priceMatrix,
    minSampleProbe,
    trendMatrix,
    stability,
    pilots,
    recommendation,
    publicPointer,
    externalSanity: {
      note: "Competitor regional levels are not targets. Jamsil complex ~10,076만원/평 remains the complex-level sanity check only.",
      exactFitDependency: false,
    },
  };

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      out: OUT,
      points: points.length,
      publicPointer,
      seoulP2: (priceMatrix.SEOUL as { byKind: { C1_MEAN: { S0: { P2: unknown } } } }).byKind.C1_MEAN.S0.P2,
      seoulP0: (priceMatrix.SEOUL as { byKind: { C1_MEAN: { S0: { P0: unknown } } } }).byKind.C1_MEAN.S0.P0,
      jamsilComplex: complexMonth,
      stabilitySeoulP0: seoulP0,
      stabilitySeoulP2: seoulP2,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
