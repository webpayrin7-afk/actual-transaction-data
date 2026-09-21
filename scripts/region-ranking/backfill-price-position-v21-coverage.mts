/**
 * Classify Seoul complexes missing price-position-v2.1 and insert-only
 * the deterministic 20/30/40평대 rows the exclusive-area loader dropped.
 *
 * Does not update existing snapshot keys.
 *
 * Usage:
 *   tsx scripts/region-ranking/backfill-price-position-v21-coverage.mts
 *   tsx scripts/region-ranking/backfill-price-position-v21-coverage.mts --apply
 */
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import {
  BAND_TO_SUPPLY_COHORT,
  exactSupplyPyeong,
  pricePerSupplyPyeong,
  type ComplexIdentityV2,
  type SupplySalePoint,
} from "../../src/lib/region-ranking/price-position-v2";
import {
  buildPricePositionV21,
  PRICE_POSITION_V21_AS_OF,
  pricePositionV21SnapshotId,
  TREND_HORIZONS_V21,
  type PricePositionBodyV21,
} from "../../src/lib/region-ranking/price-position-v21";
import type { RegionalAreaBandId } from "../../src/lib/region-ranking/area-band";

const SNAP = pricePositionV21SnapshotId();
const AS_OF = PRICE_POSITION_V21_AS_OF;
const FLOOR_YM = "202107";
const ASOF_YM = "202609";
const APPLY = process.argv.includes("--apply");
const MANIFEST = "/tmp/building-hub-bulk/external-evidence/v21-coverage-backfill-manifest.json";

const BANDS: RegionalAreaBandId[] = ["59", "84", "114"];
const LABEL_TO_BAND: Array<{ band: RegionalAreaBandId; min: number; max: number; exMin: number; exMax: number }> = [
  { band: "59", min: 20, max: 30, exMin: 55, exMax: 65 },
  { band: "84", min: 30, max: 40, exMin: 80, exMax: 90 },
  { band: "114", min: 40, max: 50, exMin: 110, exMax: 120 },
];

type Reason =
  | "MATERIALIZER_MISSED_ELIGIBLE_20_30_40"
  | "ONLY_NON_20_30_40_COHORT"
  | "SUPPLY_LABEL_RESOLVES_BUT_NO_MAPPED_TRADE_IN_WINDOW"
  | "TRADE_EXISTS_BUT_MAPPING_NOT_RESOLVABLE"
  | "IDENTITY_OR_JOIN_ANOMALY"
  | "OTHER_EXPLAINED"
  | "UNKNOWN";

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function ymKey(dealDate: string): string {
  return dealDate.slice(0, 4) + dealDate.slice(5, 7);
}

function decadeName(label: number): string {
  if (label >= 100) return "100+";
  const decade = Math.floor(label / 10) * 10;
  return decade >= 10 ? `${decade}평대` : "under10";
}

function inExclusiveWindow(label: number, exclusive: number): boolean {
  const band = LABEL_TO_BAND.find((row) => label >= row.min && label < row.max);
  if (!band) return false;
  return exclusive >= band.exMin && exclusive <= band.exMax;
}

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

async function main() {
  const db = client();
  const lawds = seoulLawdCodes();
  const covered = new Set<string>();
  const coveredRows = await db.execute({
    sql: `SELECT complex_id FROM complex_region_price_position WHERE snapshot_id=?`,
    args: [SNAP],
  });
  for (const row of coveredRows.rows) covered.add(String(row.complex_id));
  const beforeRows = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [SNAP] })).rows[0]?.n,
  );
  const beforeComplexes = covered.size;

  const floorSupply = new Map<string, number>();
  const floorComplexes = new Set<string>();
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
      if (row.level === "EXACT_FLOOR" && !row.buildingDong) {
        floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
        floorComplexes.add(row.complexId);
      }
    }
  }

  const reasonCounts: Record<Reason, number> = {
    MATERIALIZER_MISSED_ELIGIBLE_20_30_40: 0,
    ONLY_NON_20_30_40_COHORT: 0,
    SUPPLY_LABEL_RESOLVES_BUT_NO_MAPPED_TRADE_IN_WINDOW: 0,
    TRADE_EXISTS_BUT_MAPPING_NOT_RESOLVABLE: 0,
    IDENTITY_OR_JOIN_ANOMALY: 0,
    OTHER_EXPLAINED: 0,
    UNKNOWN: 0,
  };
  const root = {
    exclusiveWindowOnly: 0,
    insideWindowMissed: 0,
    yearMonthMismatchOnly: 0,
    identity: 0,
    other: 0,
  };
  const otherExplained: Record<string, number> = {};
  const decadeDiag: Record<string, { supply: number; tradeSinceFloor: number; v21: number }> = {};
  for (const name of ["10평대", "20평대", "30평대", "40평대", "50평대", "60평대", "70평대", "80평대", "90평대", "100+", "under10"]) {
    decadeDiag[name] = { supply: 0, tradeSinceFloor: 0, v21: 0 };
  }
  const v21Decade = { "20평대": new Set<string>(), "30평대": new Set<string>(), "40평대": new Set<string>() };
  const bandOfCovered = await db.execute({
    sql: `SELECT complex_id, area_band FROM complex_region_price_position WHERE snapshot_id=?`,
    args: [SNAP],
  });
  for (const row of bandOfCovered.rows) {
    const band = String(row.area_band);
    const id = String(row.complex_id);
    if (band === "59") v21Decade["20평대"].add(id);
    if (band === "84") v21Decade["30평대"].add(id);
    if (band === "114") v21Decade["40평대"].add(id);
  }

  const safeIds = new Set<string>();
  const safeBands = new Map<string, Set<RegionalAreaBandId>>();
  const pointsByBand: Record<RegionalAreaBandId, SupplySalePoint[]> = { "59": [], "84": [], "114": [] };
  const identities = new Map<string, ComplexIdentityV2>();
  const supplyGap = { noSource: [] as string[], conflict: [] as string[] };
  let pipelineUniverse = 0;
  let seoulMaster = 0;

  for (const lawd of lawds) {
    const masters = await db.execute({
      sql: `SELECT complex_id, bjdong_cd, apt_name, apt_name_norm, legal_dong_name
            FROM apt_complex_master WHERE lawd_cd=?`,
      args: [lawd],
    });
    const byNorm = new Map<string, string[]>();
    const meta = new Map<string, { id: string; name: string; norm: string; dong: string; bjdong: string }>();
    for (const row of masters.rows) {
      const id = String(row.complex_id);
      const norm = String(row.apt_name_norm);
      const list = byNorm.get(norm) ?? [];
      list.push(id);
      byNorm.set(norm, list);
      meta.set(id, {
        id,
        name: String(row.apt_name ?? norm),
        norm,
        dong: String(row.legal_dong_name ?? ""),
        bjdong: String(row.bjdong_cd),
      });
      identities.set(id, {
        complexId: id,
        lawdCd: lawd,
        bjdongCd: String(row.bjdong_cd),
        aptName: String(row.apt_name ?? norm),
        legalDongName: String(row.legal_dong_name ?? ""),
      });
    }
    seoulMaster += meta.size;
    const ids = [...meta.keys()];
    if (!ids.length) continue;

    const supplies = new Map<string, number[]>();
    const exactKeys = new Set<string>();
    const supplyRows = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_area, status
            FROM apt_canonical_unit_types
            WHERE complex_id IN (${ids.map(() => "?").join(",")})`,
      args: ids,
    });
    const complexSupply = new Map<string, { exact: Set<number>; safe: Set<number>; conflict: boolean; anyPositive: boolean; noSource: boolean }>();
    const exclusives = new Map<string, { exact: boolean; labels: Set<number>; noSource: boolean }>();
    for (const row of supplyRows.rows) {
      const id = String(row.complex_id);
      const key = `${id}|${num(row.exclusive_cents)}`;
      const status = String(row.status);
      const bucket = exclusives.get(key) ?? { exact: false, labels: new Set<number>(), noSource: false };
      if (status === "NO_SOURCE") bucket.noSource = true;
      if (num(row.supply_area) > 0 && status !== "NO_SOURCE") {
        const label = marketPyeongLabelInteger(num(row.supply_area));
        if (label != null) bucket.labels.add(label);
        if (status === "EXACT_SINGLE") bucket.exact = true;
        const list = supplies.get(key) ?? [];
        list.push(num(row.supply_area));
        supplies.set(key, list);
        if (status === "EXACT_SINGLE") exactKeys.add(key);
      }
      exclusives.set(key, bucket);
    }
    for (const [key, bucket] of exclusives) {
      const id = key.slice(0, key.indexOf("|"));
      const agg = complexSupply.get(id) ?? { exact: new Set<number>(), safe: new Set<number>(), conflict: false, anyPositive: false, noSource: false };
      if (bucket.noSource) agg.noSource = true;
      if (bucket.exact && bucket.labels.size >= 1) {
        for (const label of bucket.labels) agg.exact.add(label);
        agg.anyPositive = true;
      } else if (bucket.labels.size === 1) {
        agg.safe.add([...bucket.labels][0]!);
        agg.anyPositive = true;
      } else if (bucket.labels.size > 1) {
        agg.conflict = true;
      }
      complexSupply.set(id, agg);
    }

    const tx = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, deal_date, year_month
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND deal_amount>0 AND exclusive_area>0 AND deal_date<=?`,
      args: [lawd, AS_OF],
    });

    type Agg = {
      latest: string;
      latestMapped: string;
      rawSinceFloor: number;
      rawSince5y: number;
      mappedSinceFloor: number;
      mappedSince5y: number;
      unresolvedSince5y: number;
      decades: Set<string>;
      decadesInFloor: Set<string>;
      eligibleBands: Set<RegionalAreaBandId>;
      insideWindow: number;
      outsideWindow: number;
      yearMonthMismatch: number;
    };
    const aggs = new Map<string, Agg>();
    function aggFor(id: string): Agg {
      const cur = aggs.get(id);
      if (cur) return cur;
      const next: Agg = {
        latest: "",
        latestMapped: "",
        rawSinceFloor: 0,
        rawSince5y: 0,
        mappedSinceFloor: 0,
        mappedSince5y: 0,
        unresolvedSince5y: 0,
        decades: new Set<string>(),
        decadesInFloor: new Set<string>(),
        eligibleBands: new Set<RegionalAreaBandId>(),
        insideWindow: 0,
        outsideWindow: 0,
        yearMonthMismatch: 0,
      };
      aggs.set(id, next);
      return next;
    }

    for (const row of tx.rows) {
      const norm = String(row.apt_name_norm);
      const idsForNorm = byNorm.get(norm) ?? [];
      if (idsForNorm.length !== 1) continue;
      const id = idsForNorm[0]!;
      const dealDate = String(row.deal_date);
      const dealYm = ymKey(dealDate);
      const yearMonth = String(row.year_month).padStart(6, "0");
      const agg = aggFor(id);
      if (dealDate > agg.latest) agg.latest = dealDate;
      const sinceFloor = dealYm >= FLOOR_YM && dealYm <= ASOF_YM;
      const since5y = dealDate >= "2021-09-17" && dealDate <= AS_OF;
      if (sinceFloor) agg.rawSinceFloor += 1;
      if (since5y) agg.rawSince5y += 1;

      const exclusive = num(row.exclusive_area);
      const ex = exclusiveCents(exclusive);
      const pair = `${id}|${ex}`;
      const floorHit = floorSupply.get(`${pair}|${num(row.floor)}`);
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
        const labels = [...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((x): x is number => x != null))];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas.find((area) => marketPyeongLabelInteger(area) === label) ?? areas[0] ?? null;
        }
      }
      if (label == null || supplyArea == null) {
        if (since5y) agg.unresolvedSince5y += 1;
        continue;
      }
      if (dealDate > agg.latestMapped) agg.latestMapped = dealDate;
      const decade = decadeName(label);
      agg.decades.add(decade);
      const loaderYm = yearMonth >= FLOOR_YM && yearMonth <= ASOF_YM && dealDate <= AS_OF;
      if (loaderYm && sinceFloor) agg.decadesInFloor.add(decade);
      if (sinceFloor && loaderYm) agg.mappedSinceFloor += 1;
      if (since5y && loaderYm) agg.mappedSince5y += 1;
      const supported = LABEL_TO_BAND.find((band) => label >= band.min && label < band.max);
      if (supported && loaderYm && sinceFloor) {
        agg.eligibleBands.add(supported.band);
        if (inExclusiveWindow(label, exclusive)) agg.insideWindow += 1;
        else agg.outsideWindow += 1;
        if (yearMonth !== dealYm) agg.yearMonthMismatch += 1;
        // Published complexes keep the original exclusive-window input.
        // Only missing complexes contribute their out-of-window decade trades.
        if (covered.has(id) && !inExclusiveWindow(label, exclusive)) continue;
        const dealAmount = num(row.deal_amount);
        pointsByBand[supported.band].push({
          complexId: id,
          lawdCd: lawd,
          bjdongCd: meta.get(id)!.bjdong,
          yearMonth: `${yearMonth.slice(0, 4)}-${yearMonth.slice(4)}`,
          pricePerSupplyPyeong: pricePerSupplyPyeong(dealAmount, supplyArea) ?? 0,
          pricePerMarketPyeong: dealAmount / label,
          marketPyeongLabel: label,
          dealAmount,
          exclusiveArea: exclusive,
          supplyArea,
          supplyPyeong: exactSupplyPyeong(supplyArea),
        });
      }
    }

    for (const id of ids) {
      const supply = complexSupply.get(id) ?? { exact: new Set<number>(), safe: new Set<number>(), conflict: false, anyPositive: false, noSource: false };
      const usable = new Set<number>([...supply.exact, ...supply.safe]);
      const supplyLabels = new Set<number>();
      for (const label of usable) supplyLabels.add(label);
      const supplyDecades = new Set<string>();
      for (const label of supplyLabels) supplyDecades.add(decadeName(label));
      for (const name of supplyDecades) {
        if (decadeDiag[name]) decadeDiag[name].supply += 1;
      }
      const agg = aggs.get(id);
      if (agg) {
        for (const name of agg.decadesInFloor) {
          if (decadeDiag[name]) decadeDiag[name].tradeSinceFloor += 1;
        }
      }
      if (covered.has(id)) continue;
      const identityBad = (byNorm.get(meta.get(id)!.norm) ?? []).length > 1;
      const raw5y = agg?.rawSince5y ?? 0;
      const mapped5y = agg?.mappedSince5y ?? 0;
      const mappedFloor = agg?.mappedSinceFloor ?? 0;
      if (!supply.anyPositive || supply.conflict && usable.size === 0) {
        if (!supply.anyPositive) {
          if (supply.noSource || !supply.conflict) supplyGap.noSource.push(id);
          else supplyGap.conflict.push(id);
        } else if (usable.size === 0 && supply.conflict) supplyGap.conflict.push(id);
      }
      if (!usable.size || raw5y === 0) continue;
      pipelineUniverse += 1;
      let reason: Reason = "UNKNOWN";
      if (identityBad) reason = "IDENTITY_OR_JOIN_ANOMALY";
      else if ((agg?.eligibleBands.size ?? 0) > 0) reason = "MATERIALIZER_MISSED_ELIGIBLE_20_30_40";
      else if (mapped5y > 0 || mappedFloor > 0) reason = "ONLY_NON_20_30_40_COHORT";
      else if (usable.size > 0 && (agg?.unresolvedSince5y ?? 0) > 0 && mapped5y === 0) reason = "TRADE_EXISTS_BUT_MAPPING_NOT_RESOLVABLE";
      else if (usable.size > 0 && mappedFloor === 0) reason = "SUPPLY_LABEL_RESOLVES_BUT_NO_MAPPED_TRADE_IN_WINDOW";
      else {
        reason = "OTHER_EXPLAINED";
        otherExplained.unclassified_pipeline = (otherExplained.unclassified_pipeline ?? 0) + 1;
      }
      reasonCounts[reason] += 1;
      if (reason === "MATERIALIZER_MISSED_ELIGIBLE_20_30_40" && agg) {
        safeIds.add(id);
        safeBands.set(id, new Set(agg.eligibleBands));
        if (agg.insideWindow > 0) root.insideWindowMissed += 1;
        else if (agg.outsideWindow > 0) root.exclusiveWindowOnly += 1;
        else root.other += 1;
        if (agg.insideWindow === 0 && agg.yearMonthMismatch > 0 && agg.outsideWindow === 0) root.yearMonthMismatchOnly += 1;
      }
    }
    console.log(JSON.stringify({ lawd, complexes: ids.length, pipelineSoFar: pipelineUniverse, safeSoFar: safeIds.size }));
  }

  decadeDiag["20평대"].v21 = v21Decade["20평대"].size;
  decadeDiag["30평대"].v21 = v21Decade["30평대"].size;
  decadeDiag["40평대"].v21 = v21Decade["40평대"].size;

  if (reasonCounts.UNKNOWN !== 0) throw new Error(`UNKNOWN=${reasonCounts.UNKNOWN}`);
  if (reasonCounts.MATERIALIZER_MISSED_ELIGIBLE_20_30_40 !== safeIds.size) {
    throw new Error("safe set diverges from category A");
  }

  const held = {
    ONLY_NON_20_30_40_COHORT: reasonCounts.ONLY_NON_20_30_40_COHORT,
    NO_MAPPED_TRADE_IN_WINDOW: reasonCounts.SUPPLY_LABEL_RESOLVES_BUT_NO_MAPPED_TRADE_IN_WINDOW,
    TRADE_MAPPING_UNRESOLVABLE: reasonCounts.TRADE_EXISTS_BUT_MAPPING_NOT_RESOLVABLE,
    IDENTITY_OR_JOIN_ANOMALY: reasonCounts.IDENTITY_OR_JOIN_ANOMALY,
    OTHER_EXPLAINED: reasonCounts.OTHER_EXPLAINED,
  };

  const builtByBand: Record<string, PricePositionBodyV21[]> = {};
  const safeBodies: Array<{ band: RegionalAreaBandId; body: PricePositionBodyV21 }> = [];
  for (const band of BANDS) {
    const built = buildPricePositionV21({
      areaBand: band,
      points: pointsByBand[band],
      identities,
      transactionAsOf: AS_OF,
    });
    const guNamed = built.bodies.map((body) => {
      const id = identities.get(body.complexId);
      const gu = id ? seoulGuName(id.lawdCd) || "구" : "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.scope === "GU") cell.label = gu;
      }
      return body;
    });
    builtByBand[band] = guNamed;
    for (const body of guNamed) {
      if (!safeIds.has(body.complexId)) continue;
      if (covered.has(body.complexId)) continue;
      if (!safeBands.get(body.complexId)?.has(band)) continue;
      if (!body.complexExactByMarketLabel || Object.keys(body.complexExactByMarketLabel).length === 0) continue;
      safeBodies.push({ band, body });
    }
  }

  const byCohort = { "20평대": 0, "30평대": 0, "40평대": 0 };
  const safeComplexes = new Set<string>();
  for (const row of safeBodies) {
    safeComplexes.add(row.body.complexId);
    if (row.band === "59") byCohort["20평대"] += 1;
    if (row.band === "84") byCohort["30평대"] += 1;
    if (row.band === "114") byCohort["40평대"] += 1;
  }
  const droppedNoSlice = safeIds.size - safeComplexes.size;

  // Supply-gap handoff among complexes with no usable label.
  let evidenceFixable = 0;
  let needsNew = 0;
  let trueAmbiguous = 0;
  let supplyOther = 0;
  const gapIds = [...new Set([...supplyGap.noSource, ...supplyGap.conflict])].filter((id) => !covered.has(id));
  for (const id of gapIds) {
    if (supplyGap.conflict.includes(id) && !supplyGap.noSource.includes(id)) {
      trueAmbiguous += 1;
      continue;
    }
    if (floorComplexes.has(id)) evidenceFixable += 1;
    else needsNew += 1;
  }
  supplyOther += Math.max(0, 446 - (evidenceFixable + needsNew + trueAmbiguous));

  const manifest = {
    snapshot: SNAP,
    apply: APPLY,
    seoulMaster,
    beforeComplexes,
    beforeRows,
    pipelineUniverse,
    reasonCounts,
    root,
    held,
    safeComplexes: safeComplexes.size,
    safeRows: safeBodies.length,
    byCohort,
    droppedNoSlice,
    categoryANotMaterialized: [...safeIds].filter((id) => !safeComplexes.has(id)).length,
    supplyGapSeen: { noSource: supplyGap.noSource.length, conflict: supplyGap.conflict.length, evidenceFixable, needsNew, trueAmbiguous, supplyOther },
    points: { "59": pointsByBand["59"].length, "84": pointsByBand["84"].length, "114": pointsByBand["114"].length },
    decadeDiag,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ phase: "dry-run", ...manifest }));

  if (!APPLY) return;
  if (reasonCounts.UNKNOWN !== 0) throw new Error("refuse apply with UNKNOWN");
  if (root.insideWindowMissed > 0) {
    console.log(JSON.stringify({ holdApply: true, reason: "inside-window misses need review", insideWindowMissed: root.insideWindowMissed }));
    return;
  }

  const jamsilBefore = await db.execute({
    sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band='84'`,
    args: [SNAP, "cx_4c63d9a100973c60"],
  });
  const jamsilHash = String(jamsilBefore.rows[0]?.payload_json ?? "").length;

  let inserts = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < safeBodies.length; i += 40) {
    const slice = safeBodies.slice(i, i + 40).map(({ band, body }) => ({
      sql: `INSERT INTO complex_region_price_position (
              snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
              reference_month, status, payload_json, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
      args: [
        SNAP,
        body.complexId,
        band,
        body.transactionAsOf,
        body.areaBandVersion,
        body.referenceMonth,
        body.status,
        JSON.stringify(body),
        now,
      ],
    }));
    await db.batch(slice, "write");
    inserts += slice.length;
  }

  const afterRows = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [SNAP] })).rows[0]?.n,
  );
  const afterComplexes = num(
    (await db.execute({ sql: `SELECT COUNT(DISTINCT complex_id) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [SNAP] })).rows[0]?.n,
  );

  // Idempotent second pass.
  let second = 0;
  for (let i = 0; i < safeBodies.length; i += 40) {
    const slice = safeBodies.slice(i, i + 40).map(({ band, body }) => ({
      sql: `INSERT INTO complex_region_price_position (
              snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
              reference_month, status, payload_json, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
      args: [SNAP, body.complexId, band, body.transactionAsOf, body.areaBandVersion, body.referenceMonth, body.status, JSON.stringify(body), now],
    }));
    await db.batch(slice, "write");
    second += slice.length;
  }
  const afterSecond = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [SNAP] })).rows[0]?.n,
  );
  const v2 = num(
    (await db.execute(`SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`)).rows[0]?.n,
  );
  const jamsilAfter = await db.execute({
    sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band='84'`,
    args: [SNAP, "cx_4c63d9a100973c60"],
  });
  if (String(jamsilAfter.rows[0]?.payload_json ?? "").length !== jamsilHash) {
    throw new Error("existing jamsil payload changed");
  }

  console.log(JSON.stringify({
    phase: "apply",
    attemptedInserts: inserts,
    rowDelta: afterRows - beforeRows,
    complexDelta: afterComplexes - beforeComplexes,
    afterRows,
    afterComplexes,
    idempotentRowCount: afterSecond,
    idempotentDelta: afterSecond - afterRows,
    secondStatements: second,
    v2Rows: v2,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
