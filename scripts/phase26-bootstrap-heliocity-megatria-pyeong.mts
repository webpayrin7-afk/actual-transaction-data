/**
 * Bootstrap supply-based pyeong labels for 헬리오시티 + 래미안안양메가트리아
 * from 건축물대장 전유공용면적.
 *
 * marketLabel = round(supplySqm / 3.3058)
 * Never exclusiveSqm / 3.3058. No per-complex UI hardcode.
 *
 *   npx tsx scripts/phase26-bootstrap-heliocity-megatria-pyeong.mts
 *   npx tsx scripts/phase26-bootstrap-heliocity-megatria-pyeong.mts --apply
 *   npx tsx scripts/phase26-bootstrap-heliocity-megatria-pyeong.mts --refresh --apply
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { replacePilotMasterBundles } from "../src/lib/unit-type/repository";
import type { UnitTypeMasterBundle } from "../src/lib/unit-type/types";

config({ path: resolve(process.cwd(), ".env.local") });

const APPLY = process.argv.includes("--apply");
const REFRESH = process.argv.includes("--refresh");
const SERVICE_KEY = process.env.MOLIT_API_KEY?.trim() ?? "";
const SQM_PER_PYEONG = 3.3058;
/** BldRgstHubService typically caps each page at 100 rows. */
const PAGE_SIZE = 100;

const TARGETS = [
  {
    aptNameNorm: "헬리오시티",
    complexKey: "heliocity",
    lawdCd: "11710",
    gu: "송파구",
    sigunguCd: "11710",
    bjdongCd: "10700",
    bun: "0913",
    ji: "0000",
  },
  {
    aptNameNorm: "래미안안양메가트리아",
    complexKey: "raemian-anyang-megatria",
    lawdCd: "41171",
    gu: "안양시 만안구",
    sigunguCd: "41171",
    bjdongCd: "10100",
    bun: "1393",
    ji: "0000",
  },
] as const;

type Target = (typeof TARGETS)[number];

type ExposRow = {
  dongNm: string;
  hoNm: string;
  exposPubuseGbCdNm: string;
  mainAtchGbCdNm: string;
  mainPurpsCdNm: string;
  etcPurps: string;
  area: number;
};

const RES_COMMON_RE =
  /벽체|계단|승강기|엘리베이터|복도|홀|코어|주현관|현관|피트|파이프|EV|E\/V|엘리베이터홀|계단실/;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function field(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return (m?.[1] ?? "").trim();
}

async function fetchExposPage(
  t: Target,
  page: number,
): Promise<{ items: ExposRow[]; total: number }> {
  const qs = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    sigunguCd: t.sigunguCd,
    bjdongCd: t.bjdongCd,
    bun: t.bun,
    ji: t.ji,
    numOfRows: String(PAGE_SIZE),
    pageNo: String(page),
  });
  const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo?${qs}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!text.includes("<totalCount>") && !text.includes("<resultCode>")) {
    throw new Error(`non-api body page=${page}: ${text.slice(0, 120)}`);
  }
  const totalMatch = text.match(/<totalCount>(\d+)<\/totalCount>/);
  const total = totalMatch ? Number(totalMatch[1]) : 0;
  const items: ExposRow[] = [];
  for (const block of text.split("<item>").slice(1)) {
    items.push({
      dongNm: field(block, "dongNm"),
      hoNm: field(block, "hoNm"),
      exposPubuseGbCdNm: field(block, "exposPubuseGbCdNm"),
      mainAtchGbCdNm: field(block, "mainAtchGbCdNm"),
      mainPurpsCdNm: field(block, "mainPurpsCdNm"),
      etcPurps: field(block, "etcPurps"),
      area: Number(field(block, "area") || 0),
    });
  }
  return { items, total };
}

async function loadAllExpos(t: Target): Promise<ExposRow[]> {
  const dir = resolve(process.cwd(), "data/poc/phase26");
  mkdirSync(dir, { recursive: true });
  const cachePath = resolve(dir, `${t.complexKey}-bld-expos-cache.json`);
  if (existsSync(cachePath) && !REFRESH) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      items: ExposRow[];
    };
    console.log(`cache hit ${t.aptNameNorm}: ${cached.items.length}`);
    return cached.items;
  }

  const first = await fetchExposPage(t, 1);
  const pages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  console.log(`${t.aptNameNorm}: total=${first.total} pages=${pages}`);
  const byPage = new Map<number, ExposRow[]>([[1, first.items]]);
  const CONCURRENCY = 6;

  async function fetchOne(p: number): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        const { items } = await fetchExposPage(t, p);
        byPage.set(p, items);
        return;
      } catch (e) {
        attempt += 1;
        if (attempt >= 8) throw e;
        await sleep(400 * attempt);
      }
    }
  }

  let next = 2;
  async function worker() {
    while (next <= pages) {
      const p = next;
      next += 1;
      await fetchOne(p);
      if (p % 50 === 0 || p === pages) {
        console.log(`  page ${p}/${pages} fetched=${byPage.size}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(0, pages - 1)) }, () =>
      worker(),
    ),
  );

  const all: ExposRow[] = [];
  for (let p = 1; p <= pages; p++) {
    const items = byPage.get(p);
    if (!items) throw new Error(`missing page ${p}`);
    all.push(...items);
  }

  writeFileSync(
    cachePath,
    JSON.stringify({
      complex: t.complexKey,
      aptNameNorm: t.aptNameNorm,
      fetchedAt: new Date().toISOString(),
      totalCount: first.total,
      count: all.length,
      items: all,
    }),
  );
  return all;
}

function buildUnits(items: ExposRow[]) {
  const byHo = new Map<string, ExposRow[]>();
  for (const row of items) {
    if (!row.dongNm || !row.hoNm) continue;
    const key = `${row.dongNm}|${row.hoNm}`;
    const cur = byHo.get(key) ?? [];
    cur.push(row);
    byHo.set(key, cur);
  }

  const units: Array<{ exclusive: number; supply: number }> = [];
  for (const rows of byHo.values()) {
    const exclusives = rows.filter(
      (r) =>
        r.exposPubuseGbCdNm === "전유" &&
        r.mainAtchGbCdNm === "주건축물" &&
        r.mainPurpsCdNm === "아파트" &&
        r.area > 0,
    );
    if (exclusives.length === 0) continue;
    const exclusive = exclusives.reduce((s, r) => s + r.area, 0);
    const partial = exclusives.some((r) =>
      /벽체|계단|승강기/.test(r.etcPurps || ""),
    );
    const commons = rows.filter((r) => {
      if (r.exposPubuseGbCdNm !== "공용" || r.mainAtchGbCdNm !== "주건축물") {
        return false;
      }
      const etc = r.etcPurps || "";
      if (RES_COMMON_RE.test(etc)) return true;
      return !partial && etc.trim() === "";
    });
    const common = commons.reduce((s, r) => s + r.area, 0);
    units.push({
      exclusive: Math.round(exclusive * 100) / 100,
      supply: Math.round((exclusive + common) * 100) / 100,
    });
  }
  return units;
}

function toBundle(
  t: Target,
  units: Array<{ exclusive: number; supply: number }>,
): UnitTypeMasterBundle {
  type Bucket = {
    exclusiveMin: number;
    exclusiveMax: number;
    householdCount: number;
    supplySum: number;
    supplyMin: number;
    supplyMax: number;
  };
  const byEx = new Map<number, Bucket>();
  for (const u of units) {
    const cents = Math.round(u.exclusive * 100);
    const cur = byEx.get(cents) ?? {
      exclusiveMin: u.exclusive,
      exclusiveMax: u.exclusive,
      householdCount: 0,
      supplySum: 0,
      supplyMin: u.supply,
      supplyMax: u.supply,
    };
    cur.exclusiveMin = Math.min(cur.exclusiveMin, u.exclusive);
    cur.exclusiveMax = Math.max(cur.exclusiveMax, u.exclusive);
    cur.supplyMin = Math.min(cur.supplyMin, u.supply);
    cur.supplyMax = Math.max(cur.supplyMax, u.supply);
    cur.householdCount += 1;
    cur.supplySum += u.supply;
    byEx.set(cents, cur);
  }

  const unitTypes = [...byEx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cents, b]) => ({
      unitTypeKey: `${t.complexKey}:ex${(cents / 100).toFixed(2)}`,
      complexKey: t.complexKey,
      supplyAreaSqm: Math.round((b.supplySum / b.householdCount) * 100) / 100,
      exclusiveAreaMin: b.exclusiveMin,
      exclusiveAreaMax: b.exclusiveMax,
      householdCount: b.householdCount,
      mappingConfidence: "building_registry_expos",
      exclusiveIncludesPartialCommon: false,
      source: "bld_rgst_expos_pubuse",
    }));

  type G = {
    marketLabel: number;
    exclusiveMin: number;
    exclusiveMax: number;
    supplyMin: number;
    supplyMax: number;
    householdCount: number;
    unitTypeKeys: string[];
  };
  const groupsMap = new Map<number, G>();
  for (const ut of unitTypes) {
    const supply = ut.supplyAreaSqm ?? 0;
    if (supply <= 0) continue;
    const label = Math.round(supply / SQM_PER_PYEONG);
    const cur = groupsMap.get(label) ?? {
      marketLabel: label,
      exclusiveMin: ut.exclusiveAreaMin,
      exclusiveMax: ut.exclusiveAreaMax,
      supplyMin: supply,
      supplyMax: supply,
      householdCount: 0,
      unitTypeKeys: [],
    };
    cur.exclusiveMin = Math.min(cur.exclusiveMin, ut.exclusiveAreaMin);
    cur.exclusiveMax = Math.max(cur.exclusiveMax, ut.exclusiveAreaMax);
    cur.supplyMin = Math.min(cur.supplyMin, supply);
    cur.supplyMax = Math.max(cur.supplyMax, supply);
    cur.householdCount += ut.householdCount ?? 0;
    cur.unitTypeKeys.push(ut.unitTypeKey);
    groupsMap.set(label, cur);
  }

  const groupRows = [...groupsMap.values()]
    .sort((a, b) => a.exclusiveMin - b.exclusiveMin)
    .map((g, i) => ({
      groupKey: `${t.complexKey}:G${i + 1}:ex${g.exclusiveMin.toFixed(2)}-${g.exclusiveMax.toFixed(2)}`,
      complexKey: t.complexKey,
      marketLabel: g.marketLabel,
      displayMode: "label+range" as const,
      supplyAreaMin: g.supplyMin,
      supplyAreaMax: g.supplyMax,
      exclusiveAreaMin: g.exclusiveMin,
      exclusiveAreaMax: g.exclusiveMax,
      householdCount: g.householdCount,
      confidence: "building_registry_supply",
      groupConfidenceHigh: true,
      labelNullReason: null,
      sortOrder: i + 1,
      source: "bld_rgst_expos_pubuse",
      unitTypeKeys: g.unitTypeKeys,
    }));

  const now = new Date().toISOString();
  return {
    classification: {
      complexKey: t.complexKey,
      aptNameNorm: t.aptNameNorm,
      lawdCd: t.lawdCd,
      gu: t.gu,
      classification: "auto-safe",
      singogaMode: "market_group",
      labelConfidence: 1,
      groupConfidenceHigh: true,
      sourcePhase: "phase26-bld-expos-label",
      provenanceJson: JSON.stringify({
        source: "BldRgstHubService/getBrExposPubuseAreaInfo",
        parcel: `${t.sigunguCd}/${t.bjdongCd}/${t.bun}`,
        pyeongFactor: SQM_PER_PYEONG,
        rule: "marketLabel=round(supply/3.3058); never exclusive/3.3058",
      }),
      updatedAt: now,
    },
    unitTypes,
    groups: groupRows.map(({ unitTypeKeys: _keys, ...g }) => g),
    links: groupRows.flatMap((g) =>
      g.unitTypeKeys.map((unitTypeKey) => ({
        unitTypeKey,
        groupKey: g.groupKey,
        complexKey: t.complexKey,
        isOutlier: false,
      })),
    ),
  };
}

async function main() {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  const bundles: UnitTypeMasterBundle[] = [];
  const summary: unknown[] = [];

  for (const t of TARGETS) {
    console.log(`\n=== ${t.aptNameNorm} ===`);
    const items = await loadAllExpos(t);
    const units = buildUnits(items);
    const bundle = toBundle(t, units);
    bundles.push(bundle);
    summary.push({
      aptNameNorm: t.aptNameNorm,
      households: units.length,
      unitTypes: bundle.unitTypes.length,
      groups: bundle.groups.length,
      around85: bundle.groups
        .filter((g) => g.exclusiveAreaMin >= 80 && g.exclusiveAreaMax <= 90)
        .map((g) => ({
          marketLabel: g.marketLabel,
          exclusive: `${g.exclusiveAreaMin}~${g.exclusiveAreaMax}`,
          supply: `${g.supplyAreaMin}~${g.supplyAreaMax}`,
          hh: g.householdCount,
        })),
    });
  }

  const outPath = resolve(
    process.cwd(),
    "data/poc/phase26/heliocity-megatria-pyeong-bootstrap.json",
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), apply: APPLY, summary },
      null,
      2,
    ),
  );
  console.log("\nsummary", JSON.stringify(summary, null, 2));

  if (!APPLY) {
    console.log("dry-run only (pass --apply to write)");
    return;
  }

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });
  const result = await replacePilotMasterBundles(bundles, db);
  console.log("applied", result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
