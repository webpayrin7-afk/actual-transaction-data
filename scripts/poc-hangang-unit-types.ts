/**
 * 한강(대우) 주택형 마스터 PoC (phase2 assertions)
 * - production DB write 없음 (Turso read-only)
 * - 신고가 production 로직 변경 없음 (그룹 소속만 산출)
 *
 * Run: npx tsx scripts/poc-hangang-unit-types.ts
 */
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  HANGANG_DAEWOO_COMPLEX,
  HANGANG_DAEWOO_UNIT_TYPES,
  HANGANG_OBSERVED_EXCLUSIVE_AREAS,
  buildExclusiveAliases,
  formatUnitTypeLabel,
  pyeongFromSupplyArea,
  resolveSingogaGroupKey,
} from "../src/lib/apt/unit-type-master";

type TradeRow = {
  id: string;
  deal_date: string;
  exclusive_area: number;
  deal_amount: number;
  floor: number;
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  // 자동 round(supply/3.3)는 81.8→25. 시장 표기는 24/25 혼재 → 마스터는 null.
  assert(pyeongFromSupplyArea(81.8) === 25, "auto formula 81.8→25 (not 24)");
  assert(pyeongFromSupplyArea(109.3) === 33, "109.3 → 33평");
  assert(pyeongFromSupplyArea(163.3) === 49, "163.3 → 49평");
  assert(pyeongFromSupplyArea(165.1) === 50, "165.1 → 50평");
  assert(
    HANGANG_DAEWOO_UNIT_TYPES.find((t) => t.typeName === "81A")
      ?.marketPyeongLabel === null,
    "81A market pyeong left null (24/25 dispute)",
  );
  assert(
    HANGANG_DAEWOO_UNIT_TYPES.reduce(
      (s, t) => s + (t.householdCount ?? 0),
      0,
    ) === 834,
    "household sum 834",
  );

  const aliases = buildExclusiveAliases(
    HANGANG_DAEWOO_COMPLEX.complexId,
    HANGANG_DAEWOO_UNIT_TYPES,
    HANGANG_OBSERVED_EXCLUSIVE_AREAS,
  );

  const aliasByCents = Object.fromEntries(
    aliases.map((a) => [a.exclusiveAreaCents, a]),
  );

  assert(aliasByCents[6000]?.mappingStatus === "ambiguous", "60 type multi");
  assert(aliasByCents[6000]?.pyeongGroup === null, "60 pyeong unresolved");
  assert(aliasByCents[8498]?.mappingStatus === "ambiguous", "84.98 type multi");
  assert(aliasByCents[8498]?.pyeongGroup === 33, "84.98 → 33 pyeong group");
  assert(aliasByCents[13413]?.mappingStatus === "unique", "134.13 unique");
  assert(aliasByCents[13413]?.pyeongGroup === 49, "134.13 → 49");
  assert(aliasByCents[13527]?.pyeongGroup === 50, "135.27 → 50 not 49");
  assert(aliasByCents[13550]?.pyeongGroup === 50, "135.5 → 50");
  assert(aliasByCents[13587]?.pyeongGroup === 50, "135.87 → 50");

  const label81 = formatUnitTypeLabel(
    HANGANG_DAEWOO_UNIT_TYPES.find((t) => t.typeName === "81A")!,
  );
  assert(label81.primary.startsWith("공급"), "official supply label without fake pyeong");
  assert(
    label81.secondary?.includes("시장평형 미확정") === true,
    "81A secondary notes unresolved market pyeong",
  );

  const label49 = formatUnitTypeLabel(
    HANGANG_DAEWOO_UNIT_TYPES.find((t) => t.typeName === "163")!,
  );
  assert(label49.primary === "49평형", "official 49 label");

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    console.log("ok: unit-type-master pure (no TURSO_DATABASE_URL)");
    return;
  }

  const db = createClient({ url, authToken });
  const areaDist = await db.execute({
    sql: `SELECT exclusive_area AS ea, COUNT(*) AS cnt,
                 SUM(CASE WHEN deal_type='trade' THEN 1 ELSE 0 END) AS trades
          FROM transactions
          WHERE apt_name_norm = ? AND lawd_cd = ?
          GROUP BY exclusive_area
          ORDER BY exclusive_area`,
    args: [HANGANG_DAEWOO_COMPLEX.aptNameNorm, HANGANG_DAEWOO_COMPLEX.lawdCd],
  });

  const trades = await db.execute({
    sql: `SELECT id, deal_date, exclusive_area, deal_amount, floor
          FROM transactions
          WHERE deal_type='trade'
            AND apt_name_norm = ? AND lawd_cd = ?
            AND (dealing_gbn IS NULL OR dealing_gbn NOT LIKE '%취소%')
          ORDER BY deal_date, id`,
    args: [HANGANG_DAEWOO_COMPLEX.aptNameNorm, HANGANG_DAEWOO_COMPLEX.lawdCd],
  });

  const tradeRows: TradeRow[] = trades.rows.map((r) => ({
    id: String(r.id),
    deal_date: String(r.deal_date),
    exclusive_area: Number(r.exclusive_area),
    deal_amount: Number(r.deal_amount),
    floor: Number(r.floor ?? 0),
  }));

  const hist = new Map<string, number>();
  let singoga = 0;
  let skipped = 0;
  for (const row of tradeRows) {
    const groupKey = resolveSingogaGroupKey(row.exclusive_area, aliases);
    if (groupKey == null) {
      skipped += 1;
      continue;
    }
    const prev = hist.get(groupKey);
    if (prev != null && row.deal_amount > prev) singoga += 1;
    hist.set(groupKey, Math.max(prev ?? 0, row.deal_amount));
  }

  const out = {
    complex: HANGANG_DAEWOO_COMPLEX,
    unitTypes: HANGANG_DAEWOO_UNIT_TYPES,
    aliases,
    observedExclusiveFromFixture: HANGANG_OBSERVED_EXCLUSIVE_AREAS,
    tursoExclusiveDistribution: areaDist.rows,
    tradeCount: tradeRows.length,
    supplyPyeongSingoga: {
      count: singoga,
      skippedUnmappedOrUnresolvedPyeong: skipped,
      note: "81.x excluded (market pyeong null); ties not singoga; cancels excluded",
    },
  };

  mkdirSync("data/poc", { recursive: true });
  writeFileSync(
    "data/poc/hangang-daewoo-unit-type-poc-result.json",
    JSON.stringify(out, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        types: HANGANG_DAEWOO_UNIT_TYPES.length,
        households: HANGANG_DAEWOO_UNIT_TYPES.reduce(
          (s, t) => s + (t.householdCount ?? 0),
          0,
        ),
        trades: tradeRows.length,
        supplyPyeongSingoga: singoga,
        skipped: skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
