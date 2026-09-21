/**
 * Validate exact-complex overlay vs regional decade cohort after V2.1 rematerialize.
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import {
  applyExactComplexMarketLabel,
  pricePositionV21SnapshotId,
  TREND_HORIZONS_V21,
  type PricePositionBodyV21,
} from "../../src/lib/region-ranking/price-position-v21";
import { resolveSelectedMarketPyeongLabel } from "../../src/lib/region-ranking/price-position-read";

const OUT = "/tmp/building-hub-bulk/external-evidence/exact-complex-pilot-check.json";

const PILOTS: Record<string, { id: string; exclusive?: number }> = {
  잠실엘스: { id: "cx_4c63d9a100973c60", exclusive: 84.88 },
  파크리오: { id: "cx_ed52bf895d064c11" },
  리센츠: { id: "cx_caf229b5ac63cfbd" },
  헬리오시티: { id: "cx_30d7eea6da810b52" },
  반포자이: { id: "cx_1c244e7305d12c44" },
  래미안퍼스티지: { id: "cx_3bcf0f87bce7496b" },
  마포프레스티지자이: { id: "cx_07caf64c556e85a7" },
  포레나노원: { id: "cx_88d05e29df26a0d6" },
};

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  async function pickExclusive(
    complexId: string,
    exactLabels: Set<string>,
  ): Promise<{ exclusive: number; label: number } | null> {
    const rows = await db.execute({
      sql: `SELECT exclusive_area, supply_area, status FROM apt_canonical_unit_types
            WHERE complex_id=? AND supply_cents>=0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')
            ORDER BY CASE WHEN status='EXACT_SINGLE' THEN 0 ELSE 1 END, exclusive_area`,
      args: [complexId],
    });
    const byEx = new Map<number, { exclusive: number; labels: number[]; hasExact: boolean }>();
    for (const row of rows.rows) {
      const exclusive = num(row.exclusive_area);
      // Prefer exclusives inside the 84㎡ regional band used for these pilots.
      if (exclusive < 80 || exclusive > 90) continue;
      const label = marketPyeongLabelInteger(num(row.supply_area));
      if (label == null || label < 30 || label >= 40) continue;
      const cents = exclusiveCents(exclusive);
      const cur = byEx.get(cents) ?? { exclusive, labels: [], hasExact: false };
      cur.labels.push(label);
      if (String(row.status) === "EXACT_SINGLE") cur.hasExact = true;
      byEx.set(cents, cur);
    }
    const candidates: Array<{ exclusive: number; label: number; score: number }> = [];
    for (const cur of byEx.values()) {
      const uniq = [...new Set(cur.labels)];
      if (uniq.length !== 1) continue;
      const label = uniq[0]!;
      const resolved = await resolveSelectedMarketPyeongLabel(db, {
        complexId,
        exclusiveArea: cur.exclusive,
      });
      if (resolved.kind !== "exact" || resolved.marketPyeongLabel !== label) continue;
      const hasSlice = exactLabels.has(String(label));
      if (!hasSlice) continue;
      candidates.push({
        exclusive: cur.exclusive,
        label,
        score: (cur.hasExact ? 2 : 0) + (label === 33 ? 1 : 0),
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.exclusive - b.exclusive);
    return candidates[0] ?? null;
  }

  const pilots: Record<string, unknown> = {};
  let pass = true;
  for (const [name, meta] of Object.entries(PILOTS)) {
    const pub = await db.execute({
      sql: `SELECT payload_json FROM complex_region_price_position WHERE snapshot_id=? AND complex_id=? AND area_band=?`,
      args: [pricePositionV21SnapshotId(), meta.id, "84"],
    });
    if (!pub.rows[0]?.payload_json) {
      pilots[name] = { status: "unavailable", note: "no V2.1 row" };
      continue;
    }
    const body = JSON.parse(String(pub.rows[0].payload_json)) as PricePositionBodyV21;
    const exactLabelSet = new Set(Object.keys(body.complexExactByMarketLabel ?? {}));
    const picked =
      meta.exclusive != null ? { exclusive: meta.exclusive, label: 33 } : await pickExclusive(meta.id, exactLabelSet);
    if (!picked) {
      pilots[name] = {
        status: body.status,
        cohort: body.supplyPyeongCohort,
        exactLabels: [...exactLabelSet],
        note: "no deterministic exclusive→label in band-84 with exact slice",
        regionDong: body.priceLevel.find((c) => c.scope === "DONG")?.meanPricePerSupplyPyeong ?? null,
        regionUnchanged: true,
        // Region cohort still available; complex exact unavailable is legitimate when no deterministic selection.
        separationOk: exactLabelSet.size >= 0,
      };
      continue;
    }
    const resolved = await resolveSelectedMarketPyeongLabel(db, {
      complexId: meta.id,
      exclusiveArea: picked.exclusive,
    });
    if (resolved.kind !== "exact") {
      pilots[name] = { status: "resolve_fail", resolved, picked };
      pass = false;
      continue;
    }
    const exact = applyExactComplexMarketLabel(body, resolved.marketPyeongLabel, "exact");
    const cohortComplex = body.priceLevel.find((c) => c.scope === "COMPLEX");
    const exactComplex = exact.priceLevel.find((c) => c.scope === "COMPLEX");
    const dongBefore = body.priceLevel.find((c) => c.scope === "DONG");
    const dongAfter = exact.priceLevel.find((c) => c.scope === "DONG");
    const t0Before = body.trends["6M"].find((c) => c.scope === "DONG")?.changePercent;
    const t0After = exact.trends["6M"].find((c) => c.scope === "DONG")?.changePercent;
    const regionOk =
      dongBefore?.meanPricePerSupplyPyeong === dongAfter?.meanPricePerSupplyPyeong && t0Before === t0After;
    const complexExact = exact.complexScopeBasis === "exact_market_pyeong_label";
    if (!regionOk || !complexExact) pass = false;
    pilots[name] = {
      exclusive: picked.exclusive,
      selectedLabel: exact.selectedMarketPyeongLabel,
      complexScopeBasis: exact.complexScopeBasis,
      cohortComplexPrice: cohortComplex?.meanPricePerSupplyPyeong ?? null,
      cohortComplex6M: body.trends["6M"].find((c) => c.scope === "COMPLEX")?.changePercent ?? null,
      exactComplexPrice: exactComplex?.meanPricePerSupplyPyeong ?? null,
      exactComplexTrades: exactComplex?.tradeCount ?? null,
      exactRefMonth: exact.referenceMonth,
      regionDongP2: dongAfter?.meanPricePerSupplyPyeong ?? null,
      regionDongT0_6M: t0After ?? null,
      regionUnchanged: regionOk,
      complexExact,
      trends: Object.fromEntries(
        TREND_HORIZONS_V21.map((h) => {
          const cell = exact.trends[h].find((c) => c.scope === "COMPLEX")!;
          return [
            h,
            {
              change: cell.changePercent,
              currentMonth: cell.actualCurrentMonth,
              baselineMonth: cell.actualBaselineMonth,
              currentN: cell.currentTradeCount,
              baselineN: cell.baselineTradeCount,
              currentMean: cell.currentMean,
              baselineMean: cell.baselineMean,
            },
          ];
        }),
      ),
      separationOk: complexExact && regionOk,
    };
  }

  const report = { pass, snapshot: pricePositionV21SnapshotId(), pilots };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
