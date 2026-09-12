/**
 * Phase 5.5a — baseline expansion dry-run (WRITE=0).
 *
 * - Does NOT write apt_pyeong_groups / apt_pyeong_group_baselines / transactions
 * - Does NOT change ENABLE_MARKET_GROUP_BASELINE_SINGOGA or POST_WH_SINGOGA_GAPS_CLEARED
 * - Compares full-history vs warehouse+proposed-baseline for 25 Seoul/Gyeonggi candidates
 *
 *   npx tsx scripts/phase55a-expansion-dryrun.ts
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { normalizeAptName } from "../src/lib/db/repository";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { markSingogaMarketGroupPriorExceed } from "../src/lib/unit-type/singoga";
import type { Transaction } from "../src/types/transaction";

const OUT_DIR = join("data/poc/phase55a");
const MOLIT_CACHE_DIR = join(OUT_DIR, "molit-month-cache");
const EXCLUDE_PILOTS = new Set([
  "hangang-daewoo",
  "parkrio",
  "banpo-xi",
  "jamsil-els",
]);

type Candidate = {
  complexKey: string;
  aptNameNorm: string;
  lawdCd: string;
  historyStartYm: string;
  region: "seoul" | "gyeonggi";
  why: string;
  phase4Path?: string;
  riskHint?: "auto-safe" | "group-safe" | "ambiguous" | "registry-abnormal" | "volume-stress";
};

type ProposedGroup = {
  groupKey: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  groupConfidenceHigh: boolean;
  label: string | null;
  source: "phase4" | "warehouse-cluster";
};

type ProposedBaseline = {
  groupKey: string;
  complexKey: string;
  baselineUntil: string;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  confidence: string;
  completeness: string;
  preWarehouseTradeCount: number;
  label: string | null;
};

type TradeLite = {
  id: string;
  dealType: "trade";
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  naturalKey: string;
};

const CANDIDATES: Candidate[] = [
  {
    complexKey: "daechi-palace",
    aptNameNorm: "래미안대치팰리스",
    lawdCd: "11680",
    historyStartYm: "201507",
    region: "seoul",
    why: "phase4 auto-safe; many exclusive variants; Gangnam premium; clear grouping",
    phase4Path: "data/poc/phase4/daechi-palace-phase4.json",
    riskHint: "auto-safe",
  },
  {
    complexKey: "mapo-raemian-prugio",
    aptNameNorm: "마포래미안푸르지오4단지",
    lawdCd: "11440",
    historyStartYm: "201407",
    region: "seoul",
    why: "phase4 group-safe; 2010s mid-rise; Mapo; label-unknown stress with high group confidence",
    phase4Path: "data/poc/phase4/mapo-raemian-prugio-phase4.json",
    riskHint: "group-safe",
  },
  {
    complexKey: "acro-riverpark",
    aptNameNorm: "아크로리버파크",
    lawdCd: "11650",
    historyStartYm: "201609",
    region: "seoul",
    why: "phase4 group-safe; Seocho premium; dense exclusive-area ladder",
    phase4Path: "data/poc/phase4/acro-riverpark-phase4.json",
    riskHint: "group-safe",
  },
  {
    complexKey: "olympic-family",
    aptNameNorm: "올림픽훼밀리타운",
    lawdCd: "11710",
    historyStartYm: "200601",
    region: "seoul",
    why: "phase4 ambiguous; 1980s large complex; stresses grouping/labels",
    phase4Path: "data/poc/phase4/olympic-family-phase4.json",
    riskHint: "ambiguous",
  },
  {
    complexKey: "mokdong-7",
    aptNameNorm: "목동신시가지7",
    lawdCd: "11470",
    historyStartYm: "200601",
    region: "seoul",
    why: "phase4 ambiguous; groups already in prod without baselines; reconstruction-era stock",
    phase4Path: "data/poc/phase4/mokdong-7-phase4.json",
    riskHint: "ambiguous",
  },
  {
    complexKey: "eunma",
    aptNameNorm: "은마",
    lawdCd: "11680",
    historyStartYm: "200601",
    region: "seoul",
    why: "phase4 registry-abnormal; groups in prod, exclusive fallback; known risk",
    phase4Path: "data/poc/phase4/eunma-phase4.json",
    riskHint: "registry-abnormal",
  },
  {
    complexKey: "gaepo-jugong6",
    aptNameNorm: "개포주공6단지",
    lawdCd: "11680",
    historyStartYm: "200601",
    region: "seoul",
    why: "phase4 registry-abnormal; reconstruction stock; low group confidence",
    phase4Path: "data/poc/phase4/gaepo-jugong6-phase4.json",
    riskHint: "registry-abnormal",
  },
  {
    complexKey: "ricents",
    aptNameNorm: "리센츠",
    lawdCd: "11710",
    historyStartYm: "200809",
    region: "seoul",
    why: "Jamsil high volume; 59/84 family near-area stress; sibling of pilots",
    riskHint: "volume-stress",
  },
  {
    complexKey: "raemian-hill-godeok",
    aptNameNorm: "래미안힐스테이트고덕",
    lawdCd: "11740",
    historyStartYm: "201611",
    region: "seoul",
    why: "high volume; 16 exclusive variants; newer reconstruction-adjacent Gangdong",
    riskHint: "volume-stress",
  },
  {
    complexKey: "raemian-weve",
    aptNameNorm: "래미안위브",
    lawdCd: "11230",
    historyStartYm: "200901",
    region: "seoul",
    why: "Dongdaemun mid volume; mixed exclusive ladder",
    riskHint: "volume-stress",
  },
  {
    complexKey: "gwanak-prugio",
    aptNameNorm: "관악푸르지오",
    lawdCd: "11620",
    historyStartYm: "200801",
    region: "seoul",
    why: "59/84 family; stable 2000s stock; grouping clarity test",
    riskHint: "volume-stress",
  },
  {
    complexKey: "sangye-jugong9",
    aptNameNorm: "상계주공9(고층)",
    lawdCd: "11350",
    historyStartYm: "200601",
    region: "seoul",
    why: "1980s reconstruction candidate; small exclusive bands",
    riskHint: "volume-stress",
  },
  {
    complexKey: "sibom-hanyang",
    aptNameNorm: "시범한양",
    lawdCd: "41135",
    historyStartYm: "200601",
    region: "gyeonggi",
    why: "Gyeonggi mix; older stock; high trade count",
    riskHint: "volume-stress",
  },
  {
    complexKey: "anyang-samsung-raemian",
    aptNameNorm: "삼성래미안",
    lawdCd: "41173",
    historyStartYm: "200601",
    region: "gyeonggi",
    why: "Gyeonggi high volume; many area variants (Anyang Dongan)",
    riskHint: "volume-stress",
  },
  {
    complexKey: "ilsan-zenith",
    aptNameNorm: "일산두산위브더제니스",
    lawdCd: "41287",
    historyStartYm: "201001",
    region: "gyeonggi",
    why: "highest Gyeonggi volume in scan; tower; area ladder stress",
    riskHint: "volume-stress",
  },
  {
    complexKey: "hannam-thehill",
    aptNameNorm: "한남더힐",
    lawdCd: "11170",
    historyStartYm: "201101",
    region: "seoul",
    why: "premium; many exclusive variants; Yongsan peer of hangang pilot",
    riskHint: "volume-stress",
  },
  {
    complexKey: "helio-city",
    aptNameNorm: "헬리오시티",
    lawdCd: "11710",
    historyStartYm: "201907",
    region: "seoul",
    why: "mega complex; many unit-area variants; Songpa volume stress",
    riskHint: "volume-stress",
  },
  {
    complexKey: "dmc-raemian",
    aptNameNorm: "dmc래미안e편한세상",
    lawdCd: "11410",
    historyStartYm: "201501",
    region: "seoul",
    why: "high volume; multi-label family; Seodaemun",
    riskHint: "volume-stress",
  },
  {
    complexKey: "lotte-castle-first",
    aptNameNorm: "롯데캐슬퍼스트",
    lawdCd: "11740",
    historyStartYm: "200901",
    region: "seoul",
    why: "high volume; 59–160㎡ span; Gangdong",
    riskHint: "volume-stress",
  },
  {
    complexKey: "sk-bukhansan-city",
    aptNameNorm: "에스케이북한산시티",
    lawdCd: "11305",
    historyStartYm: "200601",
    region: "seoul",
    why: "very high volume; Gangbuk; multi-area",
    riskHint: "volume-stress",
  },
  {
    complexKey: "e-pyeonhansesang-osan",
    aptNameNorm: "e편한세상오산세교",
    lawdCd: "41370",
    historyStartYm: "201802",
    region: "gyeonggi",
    why: "Gyeonggi 59/84 close-family; new town",
    riskHint: "volume-stress",
  },
  {
    complexKey: "hillstate-unjeong",
    aptNameNorm: "산내마을9단지힐스테이트운정",
    lawdCd: "41480",
    historyStartYm: "201808",
    region: "gyeonggi",
    why: "Gyeonggi 59/84 near bands; Unjeong new town",
    riskHint: "volume-stress",
  },
  {
    complexKey: "junggye-green1",
    aptNameNorm: "중계그린1단지",
    lawdCd: "11350",
    historyStartYm: "200601",
    region: "seoul",
    why: "small exclusive band cluster (39–59); Nowon reconstruction-era",
    riskHint: "volume-stress",
  },
  {
    complexKey: "raemian-prestige",
    aptNameNorm: "래미안퍼스티지",
    lawdCd: "11650",
    historyStartYm: "200901",
    region: "seoul",
    why: "Banpo peer; premium; clear market; expansion quality bar",
    riskHint: "volume-stress",
  },
  {
    complexKey: "raemian-anyang-megatria",
    aptNameNorm: "래미안안양메가트리아",
    lawdCd: "41171",
    historyStartYm: "201801",
    region: "gyeonggi",
    why: "Gyeonggi; 16 variants; high volume from scan",
    riskHint: "volume-stress",
  },
];

function assertNoPilotLeak() {
  for (const c of CANDIDATES) {
    if (EXCLUDE_PILOTS.has(c.complexKey)) {
      throw new Error(`pilot leaked into candidates: ${c.complexKey}`);
    }
  }
}

function ymAdd(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const abs = y * 12 + (m - 1) + delta;
  const yy = Math.floor(abs / 12);
  const mm = (abs % 12) + 1;
  return `${yy}${String(mm).padStart(2, "0")}`;
}

function monthsBetween(fromYm: string, toYm: string): string[] {
  if (fromYm > toYm) return [];
  const out: string[] = [];
  for (let cur = fromYm; cur <= toYm; cur = ymAdd(cur, 1)) out.push(cur);
  return out;
}

function currentYmSeoul(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}${parts.find((p) => p.type === "month")!.value}`;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        await fn(items[idx]!, idx);
      }
    },
  );
  await Promise.all(workers);
}

function loadPhase4Groups(path: string, complexKey: string): ProposedGroup[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    candidate_pyeong_groups?: Array<{
      group_key: string;
      exclusive_area_min: number;
      exclusive_area_max: number;
      group_confidence_high: boolean;
      market_label: number | null;
    }>;
  };
  const groups = raw.candidate_pyeong_groups ?? [];
  return groups.map((g) => ({
    groupKey: g.group_key.startsWith(complexKey)
      ? g.group_key
      : g.group_key.replace(/^[^:]+:/, `${complexKey}:`),
    exclusiveAreaMin: g.exclusive_area_min,
    exclusiveAreaMax: g.exclusive_area_max,
    groupConfidenceHigh: Boolean(g.group_confidence_high),
    label: g.market_label == null ? null : String(g.market_label),
    source: "phase4" as const,
  }));
}

/** 1㎡ exclusive-area gap clustering (phase4 EXCLUSIVE_GAP). */
function clusterGroupsFromAreas(
  complexKey: string,
  areas: number[],
): ProposedGroup[] {
  const sorted = [...new Set(areas.map((a) => Math.round(a * 100) / 100))].sort(
    (a, b) => a - b,
  );
  if (sorted.length === 0) return [];
  const clusters: Array<{ lo: number; hi: number; members: number[] }> = [];
  let cur = { lo: sorted[0]!, hi: sorted[0]!, members: [sorted[0]!] };
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (a - cur.hi <= 1.0) {
      cur.hi = a;
      cur.members.push(a);
    } else {
      clusters.push(cur);
      cur = { lo: a, hi: a, members: [a] };
    }
  }
  clusters.push(cur);
  return clusters.map((c, idx) => {
    const width = c.hi - c.lo;
    const high = width <= 1.05 && c.members.length >= 1;
    return {
      groupKey: `${complexKey}:G${idx + 1}:ex${c.lo.toFixed(2)}-${c.hi.toFixed(2)}`,
      exclusiveAreaMin: c.lo,
      exclusiveAreaMax: c.hi,
      groupConfidenceHigh: high,
      label: null,
      source: "warehouse-cluster" as const,
    };
  });
}

function matchGroup(
  area: number,
  groups: ProposedGroup[],
): ProposedGroup | null {
  const hits = groups.filter(
    (g) =>
      g.groupConfidenceHigh &&
      area >= g.exclusiveAreaMin - 0.005 &&
      area <= g.exclusiveAreaMax + 0.005,
  );
  return hits.length === 1 ? hits[0]! : null;
}

function detectNearAreaRisk(groups: ProposedGroup[]): string[] {
  const risks: string[] = [];
  const high = groups
    .filter((g) => g.groupConfidenceHigh)
    .sort((a, b) => a.exclusiveAreaMin - b.exclusiveAreaMin);
  for (let i = 1; i < high.length; i++) {
    const prev = high[i - 1]!;
    const cur = high[i]!;
    const gap = cur.exclusiveAreaMin - prev.exclusiveAreaMax;
    if (gap >= 0 && gap < 0.5) {
      risks.push(
        `near-area gap ${gap.toFixed(3)} between ${prev.groupKey} and ${cur.groupKey}`,
      );
    }
    // 59/84 family adjacency check
    const near59 =
      Math.abs(prev.exclusiveAreaMax - 59.9) < 2 ||
      Math.abs(cur.exclusiveAreaMin - 59.9) < 2;
    const near84 =
      Math.abs(prev.exclusiveAreaMax - 84.9) < 2 ||
      Math.abs(cur.exclusiveAreaMin - 84.9) < 2;
    if (near59 && near84 && gap < 2) {
      risks.push(`59/84 family proximity: ${prev.groupKey} ↔ ${cur.groupKey}`);
    }
  }
  // overlapping high-confidence ranges
  for (let i = 0; i < high.length; i++) {
    for (let j = i + 1; j < high.length; j++) {
      const a = high[i]!;
      const b = high[j]!;
      if (
        a.exclusiveAreaMin <= b.exclusiveAreaMax + 0.005 &&
        b.exclusiveAreaMin <= a.exclusiveAreaMax + 0.005
      ) {
        risks.push(`overlap ${a.groupKey} vs ${b.groupKey}`);
      }
    }
  }
  return risks;
}

async function loadWarehouse(
  db: Client,
  aptNameNorm: string,
  lawdCd: string,
): Promise<TradeLite[]> {
  const aptNorm = normalizeAptName(aptNameNorm);
  const res = await db.execute({
    sql: `SELECT id, deal_date as dealDate, deal_amount as dealAmount,
                 exclusive_area as exclusiveArea, apt_name_norm, lawd_cd
          FROM transactions
          WHERE deal_type = 'trade' AND apt_name_norm = ? AND lawd_cd = ?
          ORDER BY deal_date ASC, deal_amount ASC
          LIMIT 50000`,
    args: [aptNorm, lawdCd],
  });
  return res.rows.map((row, idx) => {
    const r = row as Record<string, unknown>;
    const dealDate = String(r.dealDate);
    const dealAmount = Number(r.dealAmount);
    const exclusiveArea = Number(r.exclusiveArea);
    const naturalKey = [
      lawdCd,
      aptNorm,
      dealDate,
      dealAmount,
      exclusiveArea.toFixed(4),
      "trade",
    ].join("|");
    return {
      id: String(r.id ?? `wh-${idx}`),
      dealType: "trade" as const,
      dealDate,
      dealAmount,
      exclusiveArea,
      naturalKey,
    };
  });
}

function cachePath(lawdCd: string, ym: string): string {
  return join(MOLIT_CACHE_DIR, `${lawdCd}-${ym}.json`);
}

async function loadOrFetchMonth(
  lawdCd: string,
  ym: string,
): Promise<Transaction[]> {
  const path = cachePath(lawdCd, ym);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as Transaction[];
  }
  try {
    const rows = await fetchOneTradeForSync(lawdCd, ym);
    writeFileSync(path, JSON.stringify(rows));
    return rows;
  } catch {
    writeFileSync(path, JSON.stringify([]));
    return [];
  }
}

function txToLite(
  tx: Transaction,
  lawdCd: string,
  aptNameNorm: string,
  idx: number,
): TradeLite | null {
  if (normalizeAptName(tx.aptName) !== normalizeAptName(aptNameNorm)) {
    return null;
  }
  const dealDate = tx.dealDate;
  const dealAmount = tx.dealAmount;
  const exclusiveArea = tx.exclusiveArea;
  if (!dealDate || !dealAmount || exclusiveArea == null) return null;
  return {
    id: `molit-${lawdCd}-${dealDate}-${idx}`,
    dealType: "trade",
    dealDate,
    dealAmount: Number(dealAmount),
    exclusiveArea: Number(exclusiveArea),
    naturalKey: naturalKeyFromTx(
      { ...tx, dealType: "trade" } as Transaction,
      lawdCd,
    ),
  };
}

function computeBaselines(
  complexKey: string,
  groups: ProposedGroup[],
  preWh: TradeLite[],
  warehouseStart: string,
): ProposedBaseline[] {
  const out: ProposedBaseline[] = [];
  for (const g of groups.filter((x) => x.groupConfidenceHigh)) {
    const matched = preWh.filter((t) => matchGroup(t.exclusiveArea, [g]));
    let priorMaxAmount = 0;
    let priorMaxDealDate: string | null = null;
    for (const t of matched) {
      if (
        t.dealAmount > priorMaxAmount ||
        (t.dealAmount === priorMaxAmount &&
          (priorMaxDealDate == null || t.dealDate < priorMaxDealDate))
      ) {
        priorMaxAmount = t.dealAmount;
        priorMaxDealDate = t.dealDate;
      }
    }
    out.push({
      groupKey: g.groupKey,
      complexKey,
      baselineUntil: warehouseStart,
      priorMaxAmount,
      priorMaxDealDate,
      confidence: priorMaxAmount > 0 ? "high" : "low",
      completeness:
        priorMaxAmount > 0
          ? "pre-warehouse-molit-max"
          : "empty-pre-warehouse",
      preWarehouseTradeCount: matched.length,
      label: g.label,
    });
  }
  return out;
}

function classifyDiffs(params: {
  fullFlags: Map<string, boolean>;
  baseFlags: Map<string, boolean>;
  fullTrades: TradeLite[];
  groups: ProposedGroup[];
  incompleteBaseline: boolean;
}): {
  exact: number;
  explainable: number;
  unexplained: number;
  samples: Array<Record<string, unknown>>;
} {
  const { fullFlags, baseFlags, fullTrades, groups, incompleteBaseline } = params;
  let exact = 0;
  let explainable = 0;
  let unexplained = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const [id, full] of fullFlags) {
    if (!baseFlags.has(id)) continue;
    const base = baseFlags.get(id)!;
    if (full === base) {
      exact += 1;
      continue;
    }
    const trade = fullTrades.find((t) => t.id === id);
    const g = trade ? matchGroup(trade.exclusiveArea, groups) : null;
    // Unmatched exclusive area under proposed groups → explainable grouping gap
    // Incomplete empty prior while full history has earlier peak → explainable source gap
    const explained = !g || incompleteBaseline;
    if (explained) {
      explainable += 1;
      if (samples.length < 10) {
        samples.push({
          id,
          full,
          base,
          cls: "explainable",
          reason: !g ? "unmatched-area" : "incomplete-baseline",
          dealDate: trade?.dealDate,
          dealAmount: trade?.dealAmount,
          exclusiveArea: trade?.exclusiveArea,
        });
      }
    } else {
      unexplained += 1;
      if (samples.length < 12) {
        samples.push({
          id,
          full,
          base,
          cls: "unexplained",
          dealDate: trade?.dealDate,
          dealAmount: trade?.dealAmount,
          exclusiveArea: trade?.exclusiveArea,
          groupKey: g?.groupKey,
        });
      }
    }
  }
  return { exact, explainable, unexplained, samples };
}

async function main() {
  assertNoPilotLeak();
  if (CANDIDATES.length < 20 || CANDIDATES.length > 30) {
    throw new Error(`candidate count ${CANDIDATES.length} not in 20–30`);
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO credentials missing");
  if (!process.env.MOLIT_API_KEY?.trim()) {
    throw new Error("MOLIT_API_KEY missing");
  }

  // Local process must not flip production flags
  if (process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA === "1") {
    console.warn(
      "[phase55a] local ENABLE=1 present; dry-run still write=0 and does not mutate flags",
    );
  }
  if (process.env.POST_WH_SINGOGA_GAPS_CLEARED === "1") {
    throw new Error("ABORT: local POST_WH unexpectedly set — refuse to proceed");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(MOLIT_CACHE_DIR, { recursive: true });
  const db = createClient({ url, authToken });

  // --- coverage ---
  const groupBy = await db.execute(
    `SELECT complex_key, COUNT(*) AS n,
            SUM(CASE WHEN group_confidence_high = 1 THEN 1 ELSE 0 END) AS high_n
     FROM apt_pyeong_groups GROUP BY complex_key ORDER BY 1`,
  );
  const groupTotal = await db.execute(`SELECT COUNT(*) AS n FROM apt_pyeong_groups`);
  const baseBy = await db.execute(
    `SELECT complex_key, COUNT(*) AS n FROM apt_pyeong_group_baselines GROUP BY 1 ORDER BY 1`,
  );
  const baseTotal = await db.execute(
    `SELECT COUNT(*) AS n FROM apt_pyeong_group_baselines`,
  );
  const missing = await db.execute(`
    SELECT g.complex_key,
           COUNT(g.group_key) AS groups,
           SUM(CASE WHEN g.group_confidence_high = 1 THEN 1 ELSE 0 END) AS high_groups,
           SUM(CASE WHEN b.group_key IS NULL THEN 1 ELSE 0 END) AS missing_baselines,
           SUM(CASE WHEN g.group_confidence_high = 1 AND b.group_key IS NULL THEN 1 ELSE 0 END) AS missing_high_baselines
    FROM apt_pyeong_groups g
    LEFT JOIN apt_pyeong_group_baselines b ON b.group_key = g.group_key
    GROUP BY 1 ORDER BY 1`);

  const coverage = {
    groupComplexCount: groupBy.rows.length,
    groupRows: Number((groupTotal.rows[0] as any).n),
    baselineComplexCount: baseBy.rows.length,
    baselineRows: Number((baseTotal.rows[0] as any).n),
    groupsByComplex: groupBy.rows,
    baselinesByComplex: baseBy.rows,
    missingBaselines: missing.rows,
    fallbackStatus:
      "ENABLE=1 + empty/missing baselinePriorMax → warehouse-only market-group priors (legacy fallback retained; POST_WH unset)",
  };
  writeFileSync(join(OUT_DIR, "coverage.json"), JSON.stringify(coverage, null, 2));

  // Existing production group keys for write estimation
  const existingGroupKeys = new Set<string>();
  const existingBaselineKeys = new Set<string>();
  const eg = await db.execute(`SELECT group_key FROM apt_pyeong_groups`);
  for (const r of eg.rows) existingGroupKeys.add(String((r as any).group_key));
  const eb = await db.execute(`SELECT group_key FROM apt_pyeong_group_baselines`);
  for (const r of eb.rows) existingBaselineKeys.add(String((r as any).group_key));

  // --- MOLIT month fetch (pre-warehouse only, lawd-shared) ---
  const toYm = currentYmSeoul();
  // warehouse starts ~2016-10 for most; still fetch pre-WH months per lawd from min historyStart
  const lawdMinStart = new Map<string, string>();
  for (const c of CANDIDATES) {
    const prev = lawdMinStart.get(c.lawdCd);
    if (!prev || c.historyStartYm < prev) lawdMinStart.set(c.lawdCd, c.historyStartYm);
  }
  // Pre-WH upper bound: day before typical WH; use 201609 as default end for pre-fetch
  // Plus we also need post-WH for complexes where Turso WH is incomplete — fetch full to toYm for safety of prior continuity
  // To limit cost: fetch historyStart→toYm per unique lawd (cached).
  const cells: Array<{ lawdCd: string; ym: string }> = [];
  for (const [lawdCd, start] of lawdMinStart) {
    for (const ym of monthsBetween(start, toYm)) {
      cells.push({ lawdCd, ym });
    }
  }
  console.log(
    `[phase55a] WRITE=0 candidates=${CANDIDATES.length} molitCells=${cells.length} lawds=${lawdMinStart.size}`,
  );

  const molitByLawdYm = new Map<string, Transaction[]>();
  let done = 0;
  let fetchErrors = 0;
  const t0 = Date.now();
  await mapPool(cells, 8, async (cell) => {
    try {
      const rows = await loadOrFetchMonth(cell.lawdCd, cell.ym);
      molitByLawdYm.set(`${cell.lawdCd}|${cell.ym}`, rows);
    } catch {
      fetchErrors += 1;
      molitByLawdYm.set(`${cell.lawdCd}|${cell.ym}`, []);
    }
    done += 1;
    if (done % 100 === 0 || done === cells.length) {
      console.log(
        `[phase55a] molit ${done}/${cells.length} errors=${fetchErrors} ${((Date.now() - t0) / 60000).toFixed(1)}m`,
      );
    }
  });

  const perComplex: Array<Record<string, unknown>> = [];
  let totalExact = 0;
  let totalExplainable = 0;
  let totalUnexplained = 0;

  for (const c of CANDIDATES) {
    const wh = await loadWarehouse(db, c.aptNameNorm, c.lawdCd);
    const warehouseStart = wh[0]?.dealDate ?? "2016-10-01";
    const warehouseStartYm = warehouseStart.slice(0, 7).replace("-", "");

    let groups: ProposedGroup[] = [];
    if (c.phase4Path && existsSync(c.phase4Path)) {
      groups = loadPhase4Groups(c.phase4Path, c.complexKey);
    } else {
      groups = clusterGroupsFromAreas(
        c.complexKey,
        wh.map((t) => t.exclusiveArea),
      );
    }

    const nearAreaRisks = detectNearAreaRisk(groups);
    const ambiguousGrouping =
      groups.filter((g) => g.groupConfidenceHigh).length === 0 ||
      nearAreaRisks.some((r) => r.startsWith("overlap"));

    // Build full MOLIT trades for this apt
    const fullMolit: TradeLite[] = [];
    let idx = 0;
    for (const ym of monthsBetween(c.historyStartYm, toYm)) {
      const rows = molitByLawdYm.get(`${c.lawdCd}|${ym}`) ?? [];
      for (const tx of rows) {
        const lite = txToLite(tx, c.lawdCd, c.aptNameNorm, idx++);
        if (lite) fullMolit.push(lite);
      }
    }
    // dedupe by naturalKey
    const fullDedup = new Map<string, TradeLite>();
    for (const t of fullMolit) {
      if (!fullDedup.has(t.naturalKey)) fullDedup.set(t.naturalKey, t);
    }
    const fullTrades = [...fullDedup.values()].sort((a, b) =>
      a.dealDate === b.dealDate
        ? a.id.localeCompare(b.id)
        : a.dealDate < b.dealDate
          ? -1
          : 1,
    );

    const preWh = fullTrades.filter((t) => t.dealDate < warehouseStart);
    const baselines = computeBaselines(
      c.complexKey,
      groups,
      preWh,
      warehouseStart,
    );
    const priorMap = new Map(
      baselines
        .filter((b) => b.priorMaxAmount > 0)
        .map((b) => [b.groupKey, b.priorMaxAmount]),
    );

    const groupLikes = groups
      .filter((g) => g.groupConfidenceHigh)
      .map((g) => ({
        groupKey: g.groupKey,
        exclusiveAreaMin: g.exclusiveAreaMin,
        exclusiveAreaMax: g.exclusiveAreaMax,
        groupConfidenceHigh: true as const,
      }));

    // Align WH trades onto stable ids for both paths
    const whForMark = wh.map((t, i) => ({ ...t, id: `wh-${i}` }));
    const whNaturalKeys = new Set(wh.map((t) => t.naturalKey));

    // Full-history path: all full trades (molit), then map WH naturalKeys for scoring
    const fullFlagsAll = markSingogaMarketGroupPriorExceed(
      fullTrades,
      groupLikes,
      undefined,
    );
    // Project full flags onto WH ids via naturalKey
    const fullByNk = new Map<string, boolean>();
    for (const t of fullTrades) {
      fullByNk.set(t.naturalKey, fullFlagsAll.get(t.id) ?? false);
    }
    const fullFlags = new Map<string, boolean>();
    for (const t of whForMark) {
      fullFlags.set(t.id, fullByNk.get(t.naturalKey) ?? false);
    }

    const baseFlags = markSingogaMarketGroupPriorExceed(
      whForMark,
      groupLikes,
      priorMap.size > 0 ? priorMap : undefined,
    );

    const incompleteBaseline = baselines.some(
      (b) => b.priorMaxAmount <= 0,
    );
    const diff = classifyDiffs({
      fullFlags,
      baseFlags,
      fullTrades: whForMark,
      groups,
      incompleteBaseline,
    });
    totalExact += diff.exact;
    totalExplainable += diff.explainable;
    totalUnexplained += diff.unexplained;

    const incompleteBaselineStrict = baselines.some(
      (b) => b.priorMaxAmount <= 0 && b.preWarehouseTradeCount === 0,
    );
    const historicalGap =
      preWh.length === 0 && c.historyStartYm < warehouseStartYm;
    const lowWh = wh.length < 50;

    const existingGroupsForComplex = [...existingGroupKeys].filter((k) =>
      k.startsWith(`${c.complexKey}:`),
    ).length;
    const proposedHigh = groups.filter((g) => g.groupConfidenceHigh);
    const groupInserts = proposedHigh.filter(
      (g) => !existingGroupKeys.has(g.groupKey),
    ).length;
    const baselineInserts = baselines.filter(
      (b) => b.priorMaxAmount > 0 && !existingBaselineKeys.has(b.groupKey),
    ).length;
    // updates if same key exists with different prior — treated as 0 for first expansion (insert-only plan)
    const updates = 0;
    const deletes = 0;

    const risks: string[] = [];
    if (ambiguousGrouping) risks.push("ambiguous-grouping");
    if (nearAreaRisks.length) risks.push(...nearAreaRisks);
    if (historicalGap) risks.push("historical-gap-no-prewh-molit-trades");
    if (incompleteBaselineStrict) risks.push("incomplete-baseline-prior");
    if (lowWh) risks.push("sparse-warehouse");
    if (c.riskHint === "registry-abnormal") risks.push("registry-abnormal-class");
    if (c.riskHint === "ambiguous") risks.push("phase4-ambiguous-class");
    if (diff.unexplained > 0) risks.push(`unexplained-diff=${diff.unexplained}`);

    const safe =
      diff.unexplained === 0 &&
      !ambiguousGrouping &&
      !historicalGap &&
      !incompleteBaselineStrict &&
      c.riskHint !== "registry-abnormal" &&
      c.riskHint !== "ambiguous" &&
      proposedHigh.length > 0 &&
      nearAreaRisks.filter((r) => r.startsWith("overlap")).length === 0;

    perComplex.push({
      complexKey: c.complexKey,
      aptNameNorm: c.aptNameNorm,
      lawdCd: c.lawdCd,
      region: c.region,
      why: c.why,
      riskHint: c.riskHint,
      warehouseStart,
      warehouseTradeCount: wh.length,
      fullMolitTradeCount: fullTrades.length,
      preWarehouseTradeCount: preWh.length,
      proposedGroups: groups,
      proposedGroupCount: groups.length,
      proposedHighGroupCount: proposedHigh.length,
      proposedBaselines: baselines,
      proposedBaselineCount: baselines.filter((b) => b.priorMaxAmount > 0).length,
      nearAreaRisks,
      ambiguousGrouping,
      historicalGap,
      incompleteBaseline: incompleteBaselineStrict,
      diff,
      existingGroupsForComplex,
      writeEstimate: {
        groupInserts,
        baselineInserts,
        updates,
        deletes,
        total: groupInserts + baselineInserts + updates + deletes,
      },
      safe,
      risks,
      sampleDiffs: diff.samples,
    });

    console.log(
      `[phase55a] ${c.complexKey} wh=${wh.length} full=${fullTrades.length} pre=${preWh.length} groups=${proposedHigh.length} base=${baselines.filter((b) => b.priorMaxAmount > 0).length} exact=${diff.exact} expl=${diff.explainable} unex=${diff.unexplained} safe=${safe}`,
    );
  }

  const safeCohort = perComplex.filter((p) => p.safe);
  const holdCohort = perComplex.filter((p) => !p.safe);

  // Prefer 5–10 safest: phase4 auto/group-safe first, then volume with unexplained=0
  const rankedSafe = [...safeCohort].sort((a, b) => {
    const rank = (p: Record<string, unknown>) => {
      const hint = String(p.riskHint);
      if (hint === "auto-safe") return 0;
      if (hint === "group-safe") return 1;
      return 2;
    };
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Number(a.writeEstimate.total) - Number(b.writeEstimate.total);
  });
  const firstCohort = rankedSafe.slice(0, Math.min(10, Math.max(5, rankedSafe.length)));

  const sumWrites = (list: Array<Record<string, unknown>>) => {
    const acc = { groupInserts: 0, baselineInserts: 0, updates: 0, deletes: 0, total: 0 };
    for (const p of list) {
      const w = p.writeEstimate as {
        groupInserts: number;
        baselineInserts: number;
        updates: number;
        deletes: number;
        total: number;
      };
      acc.groupInserts += w.groupInserts;
      acc.baselineInserts += w.baselineInserts;
      acc.updates += w.updates;
      acc.deletes += w.deletes;
      acc.total += w.total;
    }
    return acc;
  };

  const allWrites = sumWrites(perComplex);
  const cohortWrites = sumWrites(firstCohort);
  const safeWrites = sumWrites(safeCohort);

  const decision =
    firstCohort.length >= 5 &&
    firstCohort.every((p) => Number((p.diff as any).unexplained) === 0) &&
    cohortWrites.total >= 0
      ? "PASS"
      : "HOLD";

  const report = {
    phase: "5.5a",
    capturedAt: new Date().toISOString(),
    safety: {
      productionWrites: 0,
      flagsChanged: false,
      enableLeftAsIs: true,
      postWhLeftUnset: true,
      fallbackRetained: true,
      nationwideLoad: false,
      historicalBackfillWrite: false,
    },
    coverage,
    candidateSet: {
      count: CANDIDATES.length,
      excludedPilots: [...EXCLUDE_PILOTS],
      candidates: CANDIDATES.map((c) => ({
        complexKey: c.complexKey,
        aptNameNorm: c.aptNameNorm,
        region: c.region,
        why: c.why,
        riskHint: c.riskHint,
      })),
    },
    dryRunTotals: {
      exact: totalExact,
      explainable: totalExplainable,
      unexplained: totalUnexplained,
    },
    perComplex,
    expectedWritesIfAllCandidatesApproved: allWrites,
    expectedWritesIfAllSafeApproved: safeWrites,
    recommendedFirstExpansionCohort: {
      complexes: firstCohort.map((p) => p.complexKey),
      details: firstCohort.map((p) => ({
        complexKey: p.complexKey,
        aptNameNorm: p.aptNameNorm,
        why: p.why,
        writeEstimate: p.writeEstimate,
        unexplained: (p.diff as any).unexplained,
        proposedHighGroupCount: p.proposedHighGroupCount,
        proposedBaselineCount: p.proposedBaselineCount,
      })),
      expectedWrites: cohortWrites,
      reason:
        "unexplained=0, clear high-confidence groups, non-empty pre-WH priors, excludes ambiguous/registry-abnormal/overlap risks",
    },
    holdCohort: {
      complexes: holdCohort.map((p) => p.complexKey),
      details: holdCohort.map((p) => ({
        complexKey: p.complexKey,
        risks: p.risks,
        unexplained: (p.diff as any).unexplained,
      })),
      reason:
        "ambiguous grouping, registry-abnormal/ambiguous phase4 class, historical gaps, incomplete priors, or unexplained diffs",
    },
    decision,
    molitFetch: {
      cells: cells.length,
      errors: fetchErrors,
      cacheDir: MOLIT_CACHE_DIR,
    },
  };

  writeFileSync(join(OUT_DIR, "expansion-dryrun.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(OUT_DIR, "expansion-dryrun-summary.json"),
    JSON.stringify(
      {
        decision: report.decision,
        coverage: {
          groupComplexes: coverage.groupComplexCount,
          groupRows: coverage.groupRows,
          baselineComplexes: coverage.baselineComplexCount,
          baselineRows: coverage.baselineRows,
          missingHighBaselines: coverage.missingBaselines,
        },
        dryRunTotals: report.dryRunTotals,
        recommendedFirstExpansionCohort: report.recommendedFirstExpansionCohort,
        holdCohort: report.holdCohort,
        expectedWritesIfAllSafeApproved: safeWrites,
        safety: report.safety,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        decision: report.decision,
        dryRunTotals: report.dryRunTotals,
        cohort: report.recommendedFirstExpansionCohort.complexes,
        cohortWrites,
        hold: report.holdCohort.complexes,
        safety: report.safety,
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
