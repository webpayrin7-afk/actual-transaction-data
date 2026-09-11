/**
 * 한강(대우) 주택형 마스터 PoC
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
  // 자동 round(supply/3.3)는 81.8→25. 마스터 명시 평형(24)과 다를 수 있음.
  assert(pyeongFromSupplyArea(81.8) === 25, "auto formula 81.8→25 (not 24)");
  assert(pyeongFromSupplyArea(109.3) === 33, "109.3 → 33평");
  assert(pyeongFromSupplyArea(163.3) === 49, "163.3 → 49평");
  assert(pyeongFromSupplyArea(165.1) === 50, "165.1 → 50평");
  assert(
    HANGANG_DAEWOO_UNIT_TYPES.find((t) => t.typeName === "81A")?.pyeongGroup ===
      24,
    "master explicit pyeongGroup for 81A is 24",
  );

  const aliases = buildExclusiveAliases(
    HANGANG_DAEWOO_COMPLEX.complexId,
    HANGANG_DAEWOO_UNIT_TYPES,
    HANGANG_OBSERVED_EXCLUSIVE_AREAS,
  );

  const aliasByCents = Object.fromEntries(
    aliases.map((a) => [a.exclusiveAreaCents, a]),
  );

  assert(aliasByCents[6000]?.pyeongGroup === 24, "60㎡ → 24");
  assert(aliasByCents[8498]?.pyeongGroup === 33, "84.98 → 33");
  assert(aliasByCents[13413]?.pyeongGroup === 49, "134.13 → 49");
  assert(aliasByCents[13550]?.pyeongGroup === 50, "135.5 → 50");
  assert(aliasByCents[13527]?.pyeongGroup === 50, "135.27 stays 50 not 49");
  assert(
    aliasByCents[6000]?.mappingStatus === "ambiguous",
    "60 type ambiguous",
  );
  assert(
    aliasByCents[13413]?.mappingStatus === "unique",
    "134.13 unique type",
  );

  const label24 = formatUnitTypeLabel(HANGANG_DAEWOO_UNIT_TYPES[0]!);
  assert(label24.primary.startsWith("전용"), "no fake 24평형 until official");
  assert(label24.secondary === null, "no supply secondary until official");

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
          WHERE apt_name_norm = ? AND lawd_cd = ? AND deal_type = 'trade'
          ORDER BY deal_date ASC, id ASC`,
    args: [HANGANG_DAEWOO_COMPLEX.aptNameNorm, HANGANG_DAEWOO_COMPLEX.lawdCd],
  });

  const tradeRows = trades.rows as unknown as TradeRow[];

  type GroupState = { maxAmount: number; members: number; singoga: number };
  const groups = new Map<string, GroupState>();
  const singogaSamples: Array<{
    id: string;
    dealDate: string;
    exclusiveArea: number;
    amount: number;
    groupKey: string;
  }> = [];

  for (const row of tradeRows) {
    const groupKey = resolveSingogaGroupKey(row.exclusive_area, aliases);
    let state = groups.get(groupKey);
    if (!state) {
      state = { maxAmount: 0, members: 0, singoga: 0 };
      groups.set(groupKey, state);
    }
    state.members += 1;
    if (state.maxAmount === 0) {
      state.maxAmount = row.deal_amount;
    } else if (row.deal_amount > state.maxAmount) {
      state.singoga += 1;
      state.maxAmount = row.deal_amount;
      if (singogaSamples.length < 15) {
        singogaSamples.push({
          id: row.id,
          dealDate: row.deal_date,
          exclusiveArea: row.exclusive_area,
          amount: row.deal_amount,
          groupKey,
        });
      }
    }
  }

  const payload = {
    complex: HANGANG_DAEWOO_COMPLEX,
    unitTypes: HANGANG_DAEWOO_UNIT_TYPES,
    aliases,
    observedExclusiveFromFixture: HANGANG_OBSERVED_EXCLUSIVE_AREAS,
    dbExclusiveDistribution: areaDist.rows,
    singogaGroupMembership: [...groups.entries()].map(([key, s]) => ({
      groupKey: key,
      tradeCount: s.members,
      singogaCountPoc: s.singoga,
      latestMaxAmount: s.maxAmount,
    })),
    singogaSamples,
    notes: [
      "supply areas verification=commercial_crosscheck (not official API)",
      "UI must not show N평형 until verification=official",
      "49 (excl 134.13) and 50 (excl 135.x) stay separated",
      "production singoga logic unchanged; membership preview only",
    ],
  };

  mkdirSync("data/poc", { recursive: true });
  writeFileSync(
    "data/poc/hangang-daewoo-unit-type-poc-result.json",
    JSON.stringify(payload, null, 2),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        aliases: aliases.map((a) => ({
          ea: a.exclusiveAreaCents / 100,
          status: a.mappingStatus,
          pyeong: a.pyeongGroup,
          typeId: a.typeId,
        })),
        singogaGroups: payload.singogaGroupMembership,
        labelsDemo: [24, 33, 49, 50].map((p) => {
          const t = HANGANG_DAEWOO_UNIT_TYPES.find((x) => x.pyeongGroup === p)!;
          return { pyeongGroup: p, label: formatUnitTypeLabel(t) };
        }),
        out: "data/poc/hangang-daewoo-unit-type-poc-result.json",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
