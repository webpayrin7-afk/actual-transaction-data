import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSelectedAreaBand } from "../src/lib/region-ranking/area-band";
import { precheckAdditiveCreateSql } from "../src/lib/region-ranking/migration-precheck";
import {
  assemblePricePosition,
  attachIdentity,
  buildSnapshotStats,
  changePercent,
  materializePayloads,
  pricePerPyeong,
  PYEONG_PER_SQM,
  shiftYearMonth,
  trendWindows,
  TREND_HORIZONS,
  type SalePoint,
  type StoredBucket,
} from "../src/lib/region-ranking/price-position";

assert.equal(shiftYearMonth("2026-09", -3), "2026-06");
assert.equal(shiftYearMonth("2026-09", -6), "2026-03");
assert.equal(shiftYearMonth("2026-09", -12), "2025-09");
assert.equal(shiftYearMonth("2026-09", -36), "2023-09");
assert.equal(shiftYearMonth("2026-01", -1), "2025-12");

const windows = trendWindows("2026-09");
assert.deepEqual(windows.current, { start: "2026-07", end: "2026-09" });
assert.deepEqual(windows.baselines["3M"], { start: "2026-04", end: "2026-06" });
assert.deepEqual(windows.baselines["6M"], { start: "2026-01", end: "2026-03" });
assert.deepEqual(windows.baselines["1Y"], { start: "2025-07", end: "2025-09" });
assert.deepEqual(windows.baselines["3Y"], { start: "2023-07", end: "2023-09" });

assert.equal(resolveSelectedAreaBand(84), "84");
assert.equal(resolveSelectedAreaBand(80), "84");
assert.equal(resolveSelectedAreaBand(90), "84");
assert.equal(resolveSelectedAreaBand(83.9), "84");
assert.equal(resolveSelectedAreaBand(89), "84");
assert.equal(resolveSelectedAreaBand(90.01), null);
assert.equal(resolveSelectedAreaBand(79.99), null);
assert.equal(resolveSelectedAreaBand(49), null);
assert.equal(resolveSelectedAreaBand(101), null);
assert.equal(resolveSelectedAreaBand(55), "59");
assert.equal(resolveSelectedAreaBand(65), "59");
assert.equal(resolveSelectedAreaBand(110), "114");
assert.equal(resolveSelectedAreaBand(120), "114");
assert.equal(resolveSelectedAreaBand(Number.NaN), null);

assert.equal(PYEONG_PER_SQM, 3.305785);
assert.equal(pricePerPyeong(100), 330.5785);
assert.equal(changePercent(110, 100), 10);
assert.equal(changePercent(80, 100), -20);
assert.equal(changePercent(100, 0), null);

function point(complexId: string, month: string, price: number, lawd = "11710", bjdong = "10100"): SalePoint {
  return { complexId, lawdCd: lawd, bjdongCd: bjdong, yearMonth: month, pricePerSqm: price };
}

function fill(complexId: string, months: string[], count: number, price: number, lawd?: string, bjdong?: string): SalePoint[] {
  const rows: SalePoint[] = [];
  for (const month of months) {
    for (let i = 0; i < count; i += 1) rows.push(point(complexId, month, price + i, lawd, bjdong));
  }
  return rows;
}

const complexMonths = ["2026-09"];
const allMonths = ["2026-07", "2026-08", "2026-09", "2026-04", "2026-05", "2026-06", "2026-01", "2026-02", "2026-03", "2025-07", "2025-08", "2025-09", "2023-07", "2023-08", "2023-09"];
const points: SalePoint[] = [
  ...fill("cx_complex", complexMonths, 1, 100),
  ...fill("cx_dong", allMonths, 2, 200),
  ...fill("cx_gu", allMonths, 2, 300, "11710", "10200"),
  ...fill("cx_seoul", allMonths, 7, 400, "11680", "10100"),
];
const built = buildSnapshotStats(points);
const named = attachIdentity(built.references, new Map([
  ["cx_complex", { aptName: "잠실엘스", legalDongName: "잠실동" }],
  ["cx_dong", { aptName: "다른단지", legalDongName: "잠실동" }],
  ["cx_gu", { aptName: "구단지", legalDongName: "신천동" }],
  ["cx_seoul", { aptName: "서울단지", legalDongName: "역삼동" }],
]));
const payloads = materializePayloads({
  areaBand: "84",
  references: named,
  buckets: built.buckets,
  guName: (lawd) => (lawd === "11710" ? "송파구" : "강남구"),
});
const body = payloads.find((row) => row.complexId === "cx_complex");
assert.ok(body);
assert.equal(body.referenceMonth, "2026-09");
assert.equal(body.changeUnit, "percentage_points");
assert.deepEqual(body.priceLevel.map((row) => row.scope), ["COMPLEX", "DONG", "GU", "SEOUL"]);
assert.deepEqual(body.priceLevel.map((row) => row.label), ["이 단지", "잠실동", "송파구", "서울"]);
assert.ok(body.priceLevel.every((row) => row.referenceMonth === "2026-09"));
assert.equal(body.priceLevel[0]?.status, "ok");
assert.equal(body.priceLevel[0]?.sampleCount, 1);
assert.equal(body.trends["3M"][0]?.status, "INSUFFICIENT_SAMPLE");
assert.equal(body.trends["3M"][0]?.changePercent, null);
assert.notEqual(body.trends["3M"][0]?.changePercent, 0);
assert.equal(body.trends["3Y"][0]?.status, "INSUFFICIENT_SAMPLE");
assert.equal(body.trends["3Y"][1]?.status, "ok");
assert.equal(body.trends["3M"][1]?.status, "ok");
assert.equal(body.trends["3M"][3]?.status, "ok");
assert.ok(body.trends["3M"].some((row) => row.status === "ok"));
assert.equal(body.status, "ok");
assert.equal(body.maxAvailableValue.priceLevel != null, true);
for (const horizon of TREND_HORIZONS) {
  assert.equal(body.trends[horizon].length, 4);
}

const old = buildSnapshotStats([
  point("cx_old", "2024-01", 10),
  point("cx_old", "2023-12", 10),
  point("cx_old", "2023-11", 10),
  point("cx_old", "2024-01", 12),
]);
const oldBody = materializePayloads({
  areaBand: "59",
  references: attachIdentity(old.references, new Map([["cx_old", { aptName: "과거", legalDongName: "잠실동" }]])),
  buckets: old.buckets,
  guName: () => "송파구",
})[0]!;
assert.equal(oldBody.referenceMonth, "2024-01");
assert.equal(oldBody.trends["3Y"][0]?.status, "INSUFFICIENT_SAMPLE");
assert.equal(oldBody.trends["3Y"][0]?.baselineTradeCount, null);
assert.equal(oldBody.trends["3Y"][0]?.changePercent, null);

const hand: StoredBucket[] = [
  { scope: "COMPLEX", scopeKey: "cx", windowKind: "month", windowEnd: "2026-09", medianPricePerSqm: 1000, tradeCount: 1 },
  { scope: "COMPLEX", scopeKey: "cx", windowKind: "roll3", windowEnd: "2026-09", medianPricePerSqm: 110, tradeCount: 2 },
  { scope: "COMPLEX", scopeKey: "cx", windowKind: "roll3", windowEnd: "2026-06", medianPricePerSqm: 100, tradeCount: 2 },
];
const manual = assemblePricePosition({
  complexId: "cx",
  aptName: "단지",
  areaBand: "84",
  referenceMonth: "2026-09",
  labels: { COMPLEX: "이 단지", DONG: "잠실동", GU: "송파구", SEOUL: "서울" },
  buckets: hand,
});
assert.equal(manual.priceLevel[0]?.medianPricePerPyeong, pricePerPyeong(1000));
assert.equal(manual.trends["3M"][0]?.changePercent, 10);
assert.equal(manual.trends["3M"][1]?.changePercent, null);
assert.equal(manual.trends["6M"][0]?.status, "INSUFFICIENT_SAMPLE");

const migration = readFileSync("src/lib/db/migrations/20260922_complex_price_position.sql", "utf8");
const precheck = precheckAdditiveCreateSql(migration);
assert.equal(precheck.ok, true);

console.log(JSON.stringify({ ok: true }));
