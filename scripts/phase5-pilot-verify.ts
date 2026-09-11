/**
 * Phase 5 pilot verification (read-only).
 *   npx tsx scripts/phase5-pilot-verify.ts
 */
import { createClient } from "@libsql/client";
import {
  PHASE5_PILOT_COMPLEXES,
  isMarketGroupClass,
} from "../src/lib/unit-type/pilot";
import {
  markSingogaExclusiveAllTimeMax,
  markSingogaMarketGroupPriorExceed,
} from "../src/lib/unit-type/singoga";
import { formatMarketGroupLabel } from "../src/lib/unit-type/labels";
import type { UnitTypeClassification } from "../src/lib/unit-type/types";

type TxRow = {
  id: string;
  deal_date: string;
  deal_amount: number;
  exclusive_area: number;
};

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("missing Turso env");
  const db = createClient({ url, authToken });

  const report: unknown[] = [];

  for (const pilot of PHASE5_PILOT_COMPLEXES) {
    const classRes = await db.execute({
      sql: `SELECT * FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [pilot.complexKey],
    });
    const classification = classRes.rows[0] as
      | Record<string, unknown>
      | undefined;
    if (!classification) {
      report.push({
        complexKey: pilot.complexKey,
        error: "classification missing",
      });
      continue;
    }

    const groupsRes = await db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE complex_key = ? ORDER BY sort_order`,
      args: [pilot.complexKey],
    });
    const groups = groupsRes.rows as unknown as Array<Record<string, unknown>>;

    const txRes = await db.execute({
      sql: `SELECT id, deal_date, deal_amount, exclusive_area
            FROM transactions
            WHERE apt_name_norm = ? AND deal_type = 'trade'
            ORDER BY deal_date ASC, id ASC`,
      args: [pilot.aptNameNorm],
    });
    const trades = txRes.rows as unknown as TxRow[];
    const totalTradeCount = trades.length;

    const tradeLikes = trades.map((t) => ({
      id: String(t.id),
      dealType: "trade",
      dealDate: String(t.deal_date),
      dealAmount: Number(t.deal_amount),
      exclusiveArea: Number(t.exclusive_area),
    }));

    const oldSingoga = markSingogaExclusiveAllTimeMax(tradeLikes);
    const oldCount = [...oldSingoga.values()].filter(Boolean).length;

    const classCode = String(
      classification.classification,
    ) as UnitTypeClassification;
    const useMarket = isMarketGroupClass(classCode);

    const marketGroups = groups
      .filter((g) => Number(g.group_confidence_high) === 1)
      .map((g) => ({
        groupKey: String(g.group_key),
        exclusiveAreaMin: Number(g.exclusive_area_min),
        exclusiveAreaMax: Number(g.exclusive_area_max),
        groupConfidenceHigh: true,
      }));

    const newSingoga = useMarket
      ? markSingogaMarketGroupPriorExceed(tradeLikes, marketGroups)
      : oldSingoga;
    const newCount = [...newSingoga.values()].filter(Boolean).length;

    const selector = useMarket
      ? groups.map((g) => {
          const label = formatMarketGroupLabel({
            marketLabel:
              g.market_label == null ? null : Number(g.market_label),
            displayMode: String(g.display_mode) as
              | "label+range"
              | "range_only"
              | "exclusive_only",
            supplyAreaMin:
              g.supply_area_min == null ? null : Number(g.supply_area_min),
            supplyAreaMax:
              g.supply_area_max == null ? null : Number(g.supply_area_max),
            exclusiveAreaMin: Number(g.exclusive_area_min),
            exclusiveAreaMax: Number(g.exclusive_area_max),
          });
          const min = Number(g.exclusive_area_min) - 0.005;
          const max = Number(g.exclusive_area_max) + 0.005;
          const inGroup = trades.filter((t) => {
            const a = Number(t.exclusive_area);
            return a >= min && a <= max;
          });
          const amounts = inGroup.map((t) => Number(t.deal_amount));
          const recent = inGroup.at(-1);
          return {
            groupKey: String(g.group_key),
            label,
            marketLabel: g.market_label,
            tradeCount: inGroup.length,
            maxAmount: amounts.length ? Math.max(...amounts) : null,
            recentDate: recent ? String(recent.deal_date) : null,
            recentAmount: recent ? Number(recent.deal_amount) : null,
          };
        })
      : null;

    let hangang4950: unknown = null;
    if (pilot.complexKey === "hangang-daewoo") {
      const g49 = groups.find((g) => Number(g.market_label) === 49);
      const g50 = groups.find((g) => Number(g.market_label) === 50);
      hangang4950 = {
        separated: Boolean(g49 && g50),
        g49: g49
          ? {
              exclusive: [
                Number(g49.exclusive_area_min),
                Number(g49.exclusive_area_max),
              ],
            }
          : null,
        g50: g50
          ? {
              exclusive: [
                Number(g50.exclusive_area_min),
                Number(g50.exclusive_area_max),
              ],
            }
          : null,
      };
    }

    let jamsilLabelNullUi: unknown = null;
    if (pilot.complexKey === "jamsil-els") {
      jamsilLabelNullUi = {
        classification: classCode,
        numericLabelForbidden: true,
        selectorLabels: (selector ?? []).map((s) => s.label),
        allRangeOnly: (selector ?? []).every(
          (s) => !/^\d+평형$/.test(String(s.label)),
        ),
      };
    }

    report.push({
      complexKey: pilot.complexKey,
      aptNameNorm: pilot.aptNameNorm,
      role: pilot.role,
      classification: classCode,
      singogaMode: classification.singoga_mode,
      totalTradeCountPreserved: totalTradeCount,
      selectorGroupTradeCounts: selector,
      oldSingogaCount: oldCount,
      newSingogaCount: newCount,
      singogaDiff: newCount - oldCount,
      hangang4950,
      jamsilLabelNullUi,
      fallbackExclusive: !useMarket
        ? { ok: true, note: "C/D exclusive selector + exclusive singoga" }
        : null,
    });
  }

  console.log(
    JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
