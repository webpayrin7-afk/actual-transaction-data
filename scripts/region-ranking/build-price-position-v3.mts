/**
 * Materialize price-position-v3 (latest-active regional representative pyeong).
 * Does not mutate V2.3 / V2.3.1 / V2.3.2 rows.
 *
 * Usage:
 *   tsx scripts/region-ranking/build-price-position-v3.mts
 *   tsx scripts/region-ranking/build-price-position-v3.mts --apply
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulGuName, seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import {
  applyExactComplexMarketLabel,
  PRICE_POSITION_V21_AS_OF,
  TREND_HORIZONS_V21,
  type PricePositionBodyV21,
} from "../../src/lib/region-ranking/price-position-v21";
import { exactSupplyPyeong, pricePerSupplyPyeong, type ComplexIdentityV2, type SupplySalePoint } from "../../src/lib/region-ranking/price-position-v2";
import { decadeCohortForLabel } from "../../src/lib/region-ranking/price-position-v22";
import {
  DECADE_COHORTS_V22,
  pricePositionV232SnapshotId,
} from "../../src/lib/region-ranking/price-position-v23";
import {
  buildPricePositionV3,
  METHODOLOGY_FINGERPRINT_V3,
  PRICE_POSITION_V3_VERSION,
  pricePositionV3SnapshotId,
} from "../../src/lib/region-ranking/price-position-v3";

const AS_OF = PRICE_POSITION_V21_AS_OF;
const FLOOR_YM = "202107";
const ASOF_YM = "202609";
const APPLY = process.argv.includes("--apply");
const SNAP3 = pricePositionV3SnapshotId();
const SNAP232 = pricePositionV232SnapshotId();
const BATCH = 40;
const BODIES = "/tmp/v3-bodies";
const REPORT = "/tmp/building-hub-bulk/external-evidence/v3-publish-report.json";
const JAMSIL = "cx_4c63d9a100973c60";
const JAMSIL_DONG = "1171010100";

/** Audit golden (pre-publish gate). */
const GOLDEN = {
  complex: 10075.7576,
  dong: 9006.3025,
  dongC: 10,
  dongA: 13,
  dongB: 10,
  gu: 4154.8387,
  guC: 169,
  seoul: 2838.2353,
  seoulC: 3375,
  dongNames: [
    "리센츠",
    "잠실엘스",
    "트리지움",
    "우성4차",
    "우성아파트",
    "주공아파트5단지",
    "레이크팰리스",
    "잠실포스코더샵",
    "잠실월드메르디앙",
    "갤러리아팰리스",
  ],
};

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso");
  return createClient({ url, authToken });
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function sameNum(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

async function countSnap(db: Client, snapshotId: string): Promise<number> {
  return num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id=?`, args: [snapshotId] }))
      .rows[0]?.n,
  );
}

async function main() {
  const db = client();
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
  }

  const canonical = new Map<string, Set<string>>();
  const points = new Map<string, SupplySalePoint[]>();
  for (const cohort of DECADE_COHORTS_V22) {
    canonical.set(cohort.key, new Set());
    points.set(cohort.key, []);
  }

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
      const exclusives = new Map<string, { labels: Set<number> }>();
      for (const row of supplyRows.rows) {
        const id = String(row.complex_id);
        const key = `${id}|${num(row.exclusive_cents)}`;
        const supplyArea = num(row.supply_area);
        if (!(supplyArea > 0)) continue;
        const label = marketPyeongLabelInteger(supplyArea);
        const bucket = exclusives.get(key) ?? { labels: new Set<number>() };
        if (label != null) bucket.labels.add(label);
        if (String(row.status) === "EXACT_SINGLE") exactKeys.add(key);
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
        const labels = [
          ...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((item): item is number => item != null)),
        ];
        if (labels.length === 1) {
          label = labels[0]!;
          supplyArea = areas[0] ?? null;
        } else continue;
      }
      if (label == null || supplyArea == null || !(label > 0)) continue;
      const cohort = decadeCohortForLabel(label);
      if (!cohort) continue;
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
    console.log(`loaded ${lawd}`);
  }

  mkdirSync(BODIES, { recursive: true });
  mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });

  let totalRows = 0;
  let jamsilBody: PricePositionBodyV21 | null = null;
  const cCounts: number[] = [];
  const ages: number[] = [];
  let freshnessTally: Record<string, number> = { FRESH: 0, STALE_MIXED: 0, STALE_HEAVY: 0 };
  let sparseLe3 = 0;
  let regionalOk = 0;
  const seenRegional = new Set<string>();

  for (const cohort of DECADE_COHORTS_V22) {
    const built = buildPricePositionV3({
      cohort,
      points: points.get(cohort.key) ?? [],
      identities,
      cohortUniverse: canonical.get(cohort.key),
      transactionAsOf: AS_OF,
    });
    for (const body of built.bodies) {
      if (body.version !== PRICE_POSITION_V3_VERSION) throw new Error("version");
      if (body.methodologyFingerprint !== METHODOLOGY_FINGERPRINT_V3) throw new Error("fingerprint");
      const gu = seoulGuName(identities.get(body.complexId)?.lawdCd ?? "") || "구";
      for (const cell of body.priceLevel) if (cell.scope === "GU") cell.label = gu;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const cell of body.trends[horizon]) if (cell.scope === "GU") cell.label = gu;
      }
      if (body.complexId === JAMSIL && cohort.key === "30") jamsilBody = body;
      const ident = identities.get(body.complexId);
      for (const cell of body.priceLevel) {
        if (cell.scope === "COMPLEX" || cell.status !== "ok") continue;
        const region =
          cell.scope === "DONG" && ident
            ? `${ident.lawdCd}${ident.bjdongCd}`
            : cell.scope === "GU" && ident
              ? ident.lawdCd
              : "SEOUL";
        const key = `${cohort.key}|${cell.scope}|${region}`;
        if (seenRegional.has(key)) continue;
        seenRegional.add(key);
        regionalOk += 1;
        const c = cell.contributingComplexCount ?? 0;
        cCounts.push(c);
        if (c <= 3) sparseLe3 += 1;
        if (cell.medianAgeMonths != null) ages.push(cell.medianAgeMonths);
        if (cell.freshnessStatus) freshnessTally[cell.freshnessStatus] = (freshnessTally[cell.freshnessStatus] ?? 0) + 1;
      }
    }
    const out = createWriteStream(`${BODIES}/${cohort.key}.jsonl`);
    for (const body of built.bodies) {
      if (!out.write(`${JSON.stringify(body)}\n`)) await once(out, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      out.on("error", reject);
      out.end(() => resolve());
    });
    totalRows += built.bodies.length;
    console.log(`built ${cohort.key} rows=${built.bodies.length}`);
  }

  cCounts.sort((a, b) => a - b);
  ages.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => (arr.length ? arr[Math.max(0, Math.ceil(p * arr.length) - 1)]! : null);

  const overlaid = jamsilBody ? applyExactComplexMarketLabel(jamsilBody, 33, "exact") : null;
  const dong = overlaid?.priceLevel.find((c) => c.scope === "DONG");
  const gu = overlaid?.priceLevel.find((c) => c.scope === "GU");
  const seoul = overlaid?.priceLevel.find((c) => c.scope === "SEOUL");
  const complex = overlaid?.priceLevel.find((c) => c.scope === "COMPLEX");

  const goldenOk =
    sameNum(complex?.meanPricePerSupplyPyeong, GOLDEN.complex) &&
    sameNum(dong?.meanPricePerSupplyPyeong, GOLDEN.dong) &&
    sameNum(dong?.contributingComplexCount, GOLDEN.dongC) &&
    sameNum(dong?.canonicalCount, GOLDEN.dongA) &&
    sameNum(dong?.historyUsableCount, GOLDEN.dongB) &&
    sameNum(gu?.meanPricePerSupplyPyeong, GOLDEN.gu) &&
    sameNum(gu?.contributingComplexCount, GOLDEN.guC) &&
    sameNum(seoul?.meanPricePerSupplyPyeong, GOLDEN.seoul) &&
    sameNum(seoul?.contributingComplexCount, GOLDEN.seoulC);

  // Trend regression: V3 body trends should match V2.3.2 for Jamsil (same trend methodology)
  let trendRegressionOk = true;
  const trendDiffs: string[] = [];
  if (jamsilBody) {
    const stored232 = await db.execute({
      sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
      args: [SNAP232, JAMSIL, "30"],
    });
    if (stored232.rows[0]) {
      const old = JSON.parse(String(stored232.rows[0].payload_json)) as PricePositionBodyV21;
      for (const horizon of TREND_HORIZONS_V21) {
        for (const scope of ["COMPLEX", "DONG", "GU", "SEOUL"] as const) {
          const a = old.trends[horizon]?.find((c) => c.scope === scope);
          const b = jamsilBody.trends[horizon]?.find((c) => c.scope === scope);
          if (!a || !b) {
            trendRegressionOk = false;
            trendDiffs.push(`${horizon}|${scope}|missing`);
            continue;
          }
          if (!sameNum(a.changePercent, b.changePercent) || a.status !== b.status) {
            trendRegressionOk = false;
            if (trendDiffs.length < 12) {
              trendDiffs.push(`${horizon}|${scope}|${a.changePercent}->${b.changePercent}`);
            }
          }
        }
      }
    }
  }

  const gate = goldenOk && trendRegressionOk && totalRows > 0;
  const report = {
    version: PRICE_POSITION_V3_VERSION,
    snapshot: SNAP3,
    fingerprint: METHODOLOGY_FINGERPRINT_V3,
    rows: totalRows,
    regionalOkCells: regionalOk,
    coverage: {
      contributorP50: pct(cCounts, 0.5),
      contributorP10: pct(cCounts, 0.1),
      contributorP90: pct(cCounts, 0.9),
      sparseLe3Rate: regionalOk ? sparseLe3 / regionalOk : null,
      ageMedian: pct(ages, 0.5),
      ageP75: pct(ages, 0.75),
      ageP90: pct(ages, 0.9),
      freshnessTally,
    },
    jamsil: {
      complex: complex?.meanPricePerSupplyPyeong ?? null,
      dong: dong?.meanPricePerSupplyPyeong ?? null,
      dongC: dong?.contributingComplexCount ?? null,
      dongA: dong?.canonicalCount ?? null,
      dongB: dong?.historyUsableCount ?? null,
      dongFreshness: dong?.freshnessStatus ?? null,
      dongAgeMed: dong?.medianAgeMonths ?? null,
      gu: gu?.meanPricePerSupplyPyeong ?? null,
      guC: gu?.contributingComplexCount ?? null,
      seoul: seoul?.meanPricePerSupplyPyeong ?? null,
      seoulC: seoul?.contributingComplexCount ?? null,
      goldenOk,
    },
    trendRegressionOk,
    trendDiffs,
    gate,
  };
  writeFileSync(REPORT, JSON.stringify(report));
  console.log(`v3 report ${REPORT} gate=${gate}`);
  console.log(JSON.stringify(report));

  if (!gate) {
    console.log("v3 pre-publish gate failed; no write");
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    console.log("v3 dry-run only");
    return;
  }

  const before3 = await countSnap(db, SNAP3);
  const before232 = await countSnap(db, SNAP232);
  const now = new Date().toISOString();
  let insertedRows = 0;
  for (const cohort of DECADE_COHORTS_V22) {
    const pending: PricePositionBodyV21[] = [];
    const rl = createInterface({ input: createReadStream(`${BODIES}/${cohort.key}.jsonl`), crlfDelay: Infinity });
    const flush = async () => {
      if (!pending.length) return;
      const slice = pending.splice(0, pending.length).map((body) => ({
        sql: `INSERT INTO complex_region_price_position (
                snapshot_id, complex_id, area_band, transaction_as_of, area_band_version,
                reference_month, status, payload_json, calculated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(snapshot_id, complex_id, area_band) DO NOTHING`,
        args: [
          SNAP3,
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
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      if (last) throw last;
      insertedRows += slice.length;
    };
    for await (const line of rl) {
      if (!line) continue;
      pending.push(JSON.parse(line) as PricePositionBodyV21);
      if (pending.length >= BATCH) await flush();
    }
    await flush();
    console.log(`inserted v3 cohort ${cohort.key}`);
  }

  // Post-parity
  let valueMismatch = 0;
  let contributorMismatch = 0;
  let freshnessMismatch = 0;
  let compared = 0;
  for (const cohort of DECADE_COHORTS_V22) {
    const stored = await db.execute({
      sql: `SELECT complex_id, payload_json FROM complex_region_price_position WHERE snapshot_id=? AND area_band=?`,
      args: [SNAP3, cohort.key],
    });
    const rebuilt = new Map<string, PricePositionBodyV21>();
    const rl = createInterface({ input: createReadStream(`${BODIES}/${cohort.key}.jsonl`), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const body = JSON.parse(line) as PricePositionBodyV21;
      rebuilt.set(body.complexId, body);
    }
    for (const row of stored.rows) {
      const a = JSON.parse(String(row.payload_json)) as PricePositionBodyV21;
      const b = rebuilt.get(String(row.complex_id));
      if (!b) {
        valueMismatch += 1;
        continue;
      }
      for (const scope of ["DONG", "GU", "SEOUL"] as const) {
        const x = a.priceLevel.find((c) => c.scope === scope);
        const y = b.priceLevel.find((c) => c.scope === scope);
        if (!x || !y) continue;
        compared += 1;
        if (!sameNum(x.meanPricePerSupplyPyeong, y.meanPricePerSupplyPyeong)) valueMismatch += 1;
        if ((x.contributingComplexCount ?? null) !== (y.contributingComplexCount ?? null)) contributorMismatch += 1;
        if (
          (x.freshnessStatus ?? null) !== (y.freshnessStatus ?? null) ||
          !sameNum(x.medianAgeMonths, y.medianAgeMonths) ||
          !sameNum(x.shareOver12Months, y.shareOver12Months) ||
          !sameNum(x.shareOver24Months, y.shareOver24Months)
        ) {
          freshnessMismatch += 1;
        }
      }
    }
  }

  const after3 = await countSnap(db, SNAP3);
  const after232 = await countSnap(db, SNAP232);
  const delta = {
    v3Rows: after3 - before3,
    v232Rows: after232 - before232,
    attempted: insertedRows,
    postParity: {
      compared,
      valueMismatch,
      contributorMismatch,
      freshnessMismatch,
      gate: valueMismatch === 0 && contributorMismatch === 0 && freshnessMismatch === 0,
    },
  };
  writeFileSync(REPORT, JSON.stringify({ ...report, delta }));
  console.log("v3 delta", delta);
  if (delta.v232Rows !== 0) throw new Error("unrelated snapshot changed");
  if (!delta.postParity.gate) {
    console.log("v3 post-apply parity failed");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
