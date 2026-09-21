import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import {
  PRICE_POSITION_PUBLIC_VERSION,
  readComplexPricePosition,
} from "../../src/lib/region-ranking/price-position-read";
import { resolveV22PricePositionRequest } from "../../src/lib/region-ranking/price-position-v22";

const CASES = [
  { name: "잠실엘스", id: "cx_4c63d9a100973c60", label: 33, legacy: "84" },
  { name: "파크리오", id: "cx_ed52bf895d064c11", label: 16, legacy: null },
  { name: "리센츠", id: "cx_caf229b5ac63cfbd", label: 33, legacy: "84" },
  { name: "헬리오시티", id: "cx_30d7eea6da810b52", label: 33, legacy: "84" },
  { name: "반포자이", id: "cx_1c244e7305d12c44", label: 50, legacy: null },
  { name: "은마", id: "cx_0320fd9e007e1f8c", label: 28, legacy: "59" },
  { name: "도곡렉슬", id: "cx_c9ed0235ecca960c", label: 51, legacy: null },
];

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  assert.equal(PRICE_POSITION_PUBLIC_VERSION, "price-position-v2.2");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const dup = await db.execute(
    `SELECT COUNT(*) n FROM (
       SELECT complex_id, area_band FROM complex_region_price_position
       WHERE snapshot_id='price-position-v2.2|2026-09-17'
       GROUP BY complex_id, area_band HAVING COUNT(*)>1
     )`,
  );
  assert.equal(num(dup.rows[0]?.n), 0);

  for (const item of CASES) {
    const supply = await db.execute({
      sql: `SELECT exclusive_cents, supply_area, status FROM apt_canonical_unit_types
            WHERE complex_id=? AND supply_cents>=0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')`,
      args: [item.id],
    });
    const byExclusive = new Map<number, { exact: boolean; labels: Set<number> }>();
    for (const row of supply.rows) {
      const cents = num(row.exclusive_cents);
      const bucket = byExclusive.get(cents) ?? { exact: false, labels: new Set<number>() };
      const label = marketPyeongLabelInteger(num(row.supply_area));
      if (label != null) bucket.labels.add(label);
      if (String(row.status) === "EXACT_SINGLE") bucket.exact = true;
      byExclusive.set(cents, bucket);
    }
    let exclusive: number | null = null;
    for (const [cents, bucket] of byExclusive) {
      if (bucket.labels.size === 1 && [...bucket.labels][0] === item.label) {
        exclusive = cents / 100;
        break;
      }
    }
    assert.ok(exclusive != null, `${item.name} missing exclusive for ${item.label}`);
    const request = resolveV22PricePositionRequest({
      areaBandRaw: item.legacy ?? "",
      exclusiveArea: exclusive,
      label: { kind: "exact", marketPyeongLabel: item.label },
    });
    assert.equal(request.ok, true);
    if (!request.ok) continue;
    const found = await readComplexPricePosition(db, {
      complexId: item.id,
      areaBand: request.decadeKey,
      exclusiveArea: exclusive,
    });
    assert.equal(found.kind, "body");
    if (found.kind !== "body") continue;
    const complex = found.body.priceLevel.find((cell) => cell.scope === "COMPLEX");
    const dong = found.body.priceLevel.find((cell) => cell.scope === "DONG");
    const gu = found.body.priceLevel.find((cell) => cell.scope === "GU");
    const seoul = found.body.priceLevel.find((cell) => cell.scope === "SEOUL");
    assert.equal(found.body.version, "price-position-v2.2");
    assert.equal(found.body.selectedMarketPyeongLabel, item.label);
    assert.equal(found.body.regionPyeongDecade, request.regionPyeongDecade);
    assert.equal(found.body.complexScopeBasis, "exact_market_pyeong_label");
    assert.equal(found.body.methodologyFingerprint.includes("region-all-decade-cohorts"), true);
    assert.ok(!("3M" in found.body.trends));
    console.log(
      JSON.stringify({
        name: item.name,
        exclusive,
        selectedMarketPyeongLabel: found.body.selectedMarketPyeongLabel,
        regionPyeongDecade: found.body.regionPyeongDecade,
        complexScopeBasis: found.body.complexScopeBasis,
        complexPrice: complex?.meanPricePerSupplyPyeong ?? null,
        complexTrades: complex?.tradeCount ?? null,
        dong: dong?.status,
        dongN: dong?.contributingComplexCount ?? null,
        gu: gu?.label,
        guStatus: gu?.status,
        seoul: seoul?.status,
        trend6: found.body.trends["6M"].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null,
      }),
    );
    if (item.name === "잠실엘스") {
      assert.equal(complex?.meanPricePerSupplyPyeong, 10075.7576);
      assert.equal(found.body.trends["6M"].find((cell) => cell.scope === "COMPLEX")?.changePercent, 3.42);
      assert.equal(found.body.trends["1Y"].find((cell) => cell.scope === "COMPLEX")?.changePercent, 0.91);
      assert.equal(found.body.trends["2Y"].find((cell) => cell.scope === "COMPLEX")?.changePercent, 23.15);
      assert.equal(found.body.trends["5Y"].find((cell) => cell.scope === "COMPLEX")?.changePercent, 32.21);
      assert.equal(dong?.meanPricePerSupplyPyeong, 10075.7576);
      assert.equal(gu?.label, "송파구");
      assert.notEqual(complex?.tradeCount, dong?.tradeCount);
    }
  }

  const legacy = await readComplexPricePosition(db, { complexId: "cx_4c63d9a100973c60", areaBand: "84" });
  assert.equal(legacy.kind, "body");
  if (legacy.kind === "body") {
    assert.equal(legacy.body.areaBand, "30");
    assert.equal(legacy.body.regionPyeongDecade, "30평대");
    assert.equal(legacy.body.complexScopeBasis, "decade_cohort");
  }
  console.log("api read regression ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
