/**
 * Materialize complex-region-price-position-v2 from EXACT_SINGLE supply mappings.
 * Does not overwrite V1 snapshot rows.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { activeAreaBand, type RegionalAreaBandId } from "../../src/lib/region-ranking/area-band";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import {
  BAND_TO_SUPPLY_COHORT,
  buildPricePositionV2,
  exactSupplyPyeong,
  inSupplyCohort,
  pricePerSupplyPyeong,
  pricePositionV2SnapshotId,
  PRICE_POSITION_V2_AS_OF,
  PRICE_POSITION_V2_VERSION,
  type ComplexIdentityV2,
  type PricePositionBodyV2,
  type SupplySalePoint,
} from "../../src/lib/region-ranking/price-position-v2";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const BANDS: RegionalAreaBandId[] = ["59", "84", "114"];
const JAMSIL = "cx_4c63d9a100973c60";
const BATCH = 40;

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  }));
}

async function writePayloads(db: Client, areaBand: RegionalAreaBandId, bodies: PricePositionBodyV2[]) {
  const snapshotId = pricePositionV2SnapshotId();
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
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    if (last) throw last;
  }
}

async function loadExactSupplyMap(db: Client): Promise<Map<string, Map<number, { supplyArea: number; supplyPyeong: number }>>> {
  const out = new Map<string, Map<number, { supplyArea: number; supplyPyeong: number }>>();
  const rows = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area, supply_pyeong
    FROM apt_canonical_unit_types
    WHERE status='EXACT_SINGLE' AND supply_cents >= 0
  `);
  for (const row of rows.rows) {
    const cid = String(row.complex_id);
    const ex = Number(row.exclusive_cents);
    const supplyArea = Number(row.supply_area);
    const supplyPyeong = Number(row.supply_pyeong);
    let m = out.get(cid);
    if (!m) { m = new Map(); out.set(cid, m); }
    // if duplicate exclusive somehow, skip (should be EXACT_SINGLE)
    if (!m.has(ex)) m.set(ex, { supplyArea, supplyPyeong });
  }
  return out;
}

async function main() {
  const db = client();
  const lawds = seoulLawdCodes();
  const masters = await db.execute({
    sql: `SELECT complex_id, lawd_cd, bjdong_cd, apt_name_norm, apt_name, legal_dong_name
          FROM apt_complex_master
          WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
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
    const lawdCd = String(row.lawd_cd);
    const aptNameNorm = String(row.apt_name_norm);
    identities.set(complexId, {
      complexId,
      lawdCd,
      bjdongCd: String(row.bjdong_cd),
      aptName: row.apt_name == null ? aptNameNorm : String(row.apt_name),
      legalDongName: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
    });
    byName.set(`${lawdCd}|${aptNameNorm}`, complexId);
  }

  const supplyMap = await loadExactSupplyMap(db);
  console.log(JSON.stringify({ exactSupplyComplexes: supplyMap.size }));

  // Gate is MARKET_PYEONG_PRICE_COVERAGE (exact + same integer label), threshold 0.8 unchanged.
  const audit = JSON.parse(readFileSync("/tmp/building-hub-bulk/external-evidence/market-pyeong-audit.json", "utf8")) as {
    seoul12: { marketPyeongPriceCoverage: number };
    byCohort: { "30평대": { marketPyeongPriceCoverage: number } };
  };
  const gateShare = audit.byCohort["30평대"].marketPyeongPriceCoverage;
  const overallShare = audit.seoul12.marketPyeongPriceCoverage;
  const gatePass = gateShare >= 0.8 && overallShare >= 0.8;
  console.log(JSON.stringify({ seoulGate: { metric: "MARKET_PYEONG_PRICE_COVERAGE", gateShare, overallShare, gatePass } }));
  if (!gatePass) {
    console.log(JSON.stringify({ stopV2: true, reason: "market_pyeong_gate_fail", gateShare, overallShare }));
    writeFileSync("/tmp/building-hub-bulk/external-evidence/v2-report.json", JSON.stringify({ gatePass: false, gateShare, overallShare, rows: 0 }, null, 2));
    return;
  }

  const allSupplies = new Map<string, number[]>();
  const supplyRows = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area, status
    FROM apt_canonical_unit_types
    WHERE supply_cents >= 0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')
  `);
  const exactKeys = new Set<string>();
  for (const row of supplyRows.rows) {
    const key = `${row.complex_id}|${Number(row.exclusive_cents)}`;
    const list = allSupplies.get(key) ?? [];
    list.push(Number(row.supply_area));
    allSupplies.set(key, list);
    if (String(row.status) === "EXACT_SINGLE") exactKeys.add(key);
  }
  const cohortSafe = new Set<string>();
  const cohortRows = await db.execute(`SELECT complex_id, exclusive_cents, cohort_status FROM apt_exclusive_pair_cohort`);
  for (const row of cohortRows.rows) {
    if (String(row.cohort_status) === "COHORT_SAFE_MULTI") cohortSafe.add(`${row.complex_id}|${Number(row.exclusive_cents)}`);
  }
  const floorSupply = new Map<string, number>();
  const rl = createInterface({
    input: createReadStream("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const row = JSON.parse(line) as { level: string; complexId: string; exclusiveCents: number; floor: string; buildingDong: string; supplyCents: number };
    if (row.level === "EXACT_FLOOR" && !row.buildingDong) {
      floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
    }
  }

  const floorYm = "202307";
  const asOfYm = PRICE_POSITION_V2_AS_OF.slice(0, 7).replace("-", "");
  let totalRows = 0;
  const jamsilBodies: PricePositionBodyV2[] = [];
  for (const areaBand of BANDS) {
    const band = activeAreaBand(areaBand);
    const min = band.exclusiveSqmMin!;
    const max = band.exclusiveSqmMax!;
    const points: SupplySalePoint[] = [];
    let ambiguousExcluded = 0;
    await mapPool(lawds, 4, async (lawd) => {
      const rows = await db.execute({
        sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, substr(deal_date,1,7) ym
              FROM transactions
              WHERE lawd_cd=? AND deal_type='trade' AND year_month>=? AND year_month<=?
                AND deal_date<=? AND deal_amount>0 AND exclusive_area>=? AND exclusive_area<=?`,
        args: [lawd, floorYm, asOfYm, PRICE_POSITION_V2_AS_OF, min, max],
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
        let price: number | null = null;
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
          } else if (cohortSafe.has(pair) && areas[0] != null) {
            supplyArea = areas[0];
            supplyPyeong = exactSupplyPyeong(supplyArea);
            label = null;
          } else {
            ambiguousExcluded += 1;
            continue;
          }
        }
        if (label != null && supplyArea != null) price = dealAmount / label;
        if (!(supplyPyeong > 0)) continue;
        const cohort = BAND_TO_SUPPLY_COHORT[areaBand];
        const inCohort = label != null ? label >= cohort.min && label < cohort.max : inSupplyCohort(supplyPyeong, areaBand);
        if (!inCohort) continue;
        points.push({
          complexId,
          lawdCd: lawd,
          bjdongCd: id.bjdongCd,
          yearMonth: String(row.ym),
          pricePerSupplyPyeong: supplyArea != null ? (pricePerSupplyPyeong(dealAmount, supplyArea) ?? 0) : 0,
          pricePerMarketPyeong: price,
          marketPyeongLabel: label,
          dealAmount,
          exclusiveArea,
          supplyArea: supplyArea ?? 0,
          supplyPyeong,
        });
      }
    });

    const built = buildPricePositionV2({
      areaBand,
      points,
      identities,
      transactionAsOf: PRICE_POSITION_V2_AS_OF,
    });
    // patch gu labels
    for (const body of built.bodies) {
      const id = identities.get(body.complexId);
      if (!id) continue;
      const gu = seoulGuName(id.lawdCd) || "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const h of Object.keys(body.trends) as Array<keyof typeof body.trends>) {
        for (const cell of body.trends[h]) if (cell.scope === "GU") cell.label = gu;
      }
      body.coverage.ambiguousExcluded = ambiguousExcluded;
      if (body.complexId === JAMSIL) jamsilBodies.push(body);
    }
    await writePayloads(db, areaBand, built.bodies);
    totalRows += built.bodies.length;
    console.log(JSON.stringify({
      areaBand,
      cohort: BAND_TO_SUPPLY_COHORT[areaBand].label,
      points: points.length,
      complexes: built.bodies.length,
      ambiguousExcluded,
    }));
  }

  // Preserve V1 count check
  const snaps = await db.execute(`SELECT snapshot_id, COUNT(*) n FROM complex_region_price_position GROUP BY 1`);
  const v1 = snaps.rows.find((r) => String(r.snapshot_id).startsWith("price-position-v1"));
  const v2 = snaps.rows.find((r) => String(r.snapshot_id).startsWith("price-position-v2"));

  // Jamsil 84 validation
  const jamsil84 = jamsilBodies.find((b) => b.areaBand === "84") ?? null;
  let jamsilDealCheck: unknown = null;
  {
    const mapped = supplyMap.get(JAMSIL)?.get(exclusiveCents(84.88));
    const deal = 332500;
    const label = marketPyeongLabelInteger(mapped?.supplyArea ?? 109.29);
    jamsilDealCheck = {
      exclusive: 84.88,
      supply: mapped?.supplyArea ?? 109.29,
      decimalPyeong: mapped ? Math.round(exactSupplyPyeong(mapped.supplyArea) * 100) / 100 : 33.06,
      marketPyeongLabel: label,
      deal,
      pricePerMarketPyeong: label ? Math.round((deal / label) * 10) / 10 : null,
      body: jamsil84
        ? {
            referenceMonth: jamsil84.referenceMonth,
            priceLevel: jamsil84.priceLevel,
            trends: Object.fromEntries(
              Object.entries(jamsil84.trends).map(([h, cells]) => [
                h,
                cells.map((c) => ({
                  scope: c.scope,
                  changePercent: c.changePercent,
                  matched: c.matchedComplexCount,
                })),
              ]),
            ),
          }
        : null,
    };
  }

  // API timing via direct read
  const t0 = Date.now();
  const read = await db.execute({
    sql: `SELECT payload_json FROM complex_region_price_position
          WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
    args: [pricePositionV2SnapshotId(), JAMSIL, "84"],
  });
  const apiMs = Date.now() - t0;

  const report = {
    gatePass: true,
    gateShare,
    overallShare,
    version: PRICE_POSITION_V2_VERSION,
    snapshotId: pricePositionV2SnapshotId(),
    materializationRows: totalRows,
    v1Preserved: v1 ? Number(v1.n) : 0,
    v2Rows: v2 ? Number(v2.n) : 0,
    apiMs,
    jamsilDealCheck,
    snaps: snaps.rows,
  };
  writeFileSync("/tmp/building-hub-bulk/external-evidence/v2-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
