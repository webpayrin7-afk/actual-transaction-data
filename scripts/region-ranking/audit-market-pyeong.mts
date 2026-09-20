/**
 * Audit P1 decimal supply pyeong vs P2 existing integer market label.
 * Recompute Seoul 12M MARKET_PYEONG_PRICE_COVERAGE. No API.
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient } from "@libsql/client";
import { exclusiveCents, exactSupplyPyeong, canonicalSupplyPyeong } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger, PYEONG_LABEL_VERSION } from "../../src/lib/unit-type/supply-label";
import { seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";

const PILOTS: Record<string, string> = {
  잠실엘스: "cx_4c63d9a100973c60",
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  래미안퍼스티지: "cx_3bcf0f87bce7496b",
  도곡렉슬: "cx_c9ed0235ecca960c",
  마포프레스티지자이: "cx_07caf64c556e85a7",
  포레나노원: "cx_88d05e29df26a0d6",
};

const BANDS: Record<string, [number, number]> = {
  "20평대": [55, 65],
  "30평대": [80, 90],
  "40평대": [110, 120],
};

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const jamsilDecimal = exactSupplyPyeong(109.29);
  const jamsilCanon = canonicalSupplyPyeong(109.29);
  const jamsilLabel = marketPyeongLabelInteger(109.29);
  const label111 = marketPyeongLabelInteger(111.52);
  const p1 = 332500 / jamsilDecimal;
  const p2 = jamsilLabel ? 332500 / jamsilLabel : null;

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  const pilots: Record<string, unknown> = {};
  for (const [name, id] of Object.entries(PILOTS)) {
    const types = await db.execute({
      sql: `SELECT exclusive_area, supply_area, status FROM apt_canonical_unit_types
            WHERE complex_id=? AND supply_cents>=0 ORDER BY exclusive_area, supply_area`,
      args: [id],
    });
    const rows = types.rows.map((r) => {
      const supply = num(r.supply_area);
      return {
        exclusive: num(r.exclusive_area),
        supply,
        decimal: Math.round(exactSupplyPyeong(supply) * 100) / 100,
        label: marketPyeongLabelInteger(supply),
        status: String(r.status),
      };
    });
    const master = await db.execute({
      sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master WHERE complex_id=?`,
      args: [id],
    });
    const lawd = String(master.rows[0]?.lawd_cd ?? "");
    const norm = String(master.rows[0]?.apt_name_norm ?? "");
    const trade = await db.execute({
      sql: `SELECT deal_date, exclusive_area, deal_amount, floor FROM transactions
            WHERE lawd_cd=? AND apt_name_norm=? AND deal_type='trade' AND deal_amount>0
              AND deal_date<='2026-09-17'
            ORDER BY deal_date DESC LIMIT 1`,
      args: [lawd, norm],
    });
    const t = trade.rows[0];
    let sample: unknown = null;
    if (t) {
      const ex = num(t.exclusive_area);
      const match = rows.filter((r) => Math.abs(r.exclusive - ex) < 0.02 || Math.round(r.exclusive * 100) === exclusiveCents(ex));
      const labels = [...new Set(match.map((r) => r.label).filter((x) => x != null))];
      const deal = num(t.deal_amount);
      const one = match.length === 1 ? match[0] : match.find((r) => r.status === "EXACT_SINGLE");
      sample = {
        dealDate: String(t.deal_date),
        exclusive: ex,
        deal,
        matchedVariants: match.length,
        labels,
        p1: one ? Math.round((deal / exactSupplyPyeong(one.supply)) * 10) / 10 : null,
        p2: labels.length === 1 ? Math.round((deal / labels[0]!) * 10) / 10 : null,
      };
    }
    const labelGroups = new Map<number, number[]>();
    for (const row of rows) {
      const c = exclusiveCents(row.exclusive);
      const list = labelGroups.get(c) ?? [];
      if (row.label != null) list.push(row.label);
      labelGroups.set(c, list);
    }
    let safe = 0;
    let amb = 0;
    for (const labels of labelGroups.values()) {
      const set = new Set(labels);
      if (set.size === 1) safe += 1;
      else if (set.size > 1) amb += 1;
    }
    pilots[name] = { variants: rows.slice(0, 8), labelSafePairs: safe, labelAmbiguousPairs: amb, sample };
  }

  const supplies = new Map<string, number[]>();
  const allTypes = await db.execute(`
    SELECT complex_id, exclusive_cents, supply_area, status
    FROM apt_canonical_unit_types WHERE supply_cents>=0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')
  `);
  const exactKey = new Set<string>();
  for (const row of allTypes.rows) {
    const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
    const list = supplies.get(key) ?? [];
    list.push(num(row.supply_area));
    supplies.set(key, list);
    if (String(row.status) === "EXACT_SINGLE") exactKey.add(key);
  }
  const labelClass = new Map<string, "EXACT" | "LABEL_SAFE_MULTI" | "LABEL_AMBIGUOUS">();
  let boundary = 0;
  for (const [key, areas] of supplies) {
    const labels = areas.map((a) => marketPyeongLabelInteger(a)).filter((x): x is number => x != null);
    for (const a of areas) {
      const frac = Math.abs(canonicalSupplyPyeong(a) - Math.round(canonicalSupplyPyeong(a)));
      if (frac >= 0.45 && frac <= 0.55) boundary += 1;
    }
    const set = new Set(labels);
    if (exactKey.has(key) && set.size === 1) labelClass.set(key, "EXACT");
    else if (set.size === 1) labelClass.set(key, "LABEL_SAFE_MULTI");
    else labelClass.set(key, "LABEL_AMBIGUOUS");
  }

  const floor = new Set<string>();
  const rl = createInterface({
    input: createReadStream("/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const row = JSON.parse(line) as { level: string; complexId: string; exclusiveCents: number; floor: string; buildingDong: string };
    if (row.level === "EXACT_FLOOR" && !row.buildingDong) floor.add(`${row.complexId}|${row.exclusiveCents}|${row.floor}`);
  }

  const lawds = seoulLawdCodes();
  const masters = await db.execute({
    sql: `SELECT complex_id, lawd_cd, apt_name_norm FROM apt_complex_master WHERE lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const byName = new Map<string, string>();
  const ambName = new Set<string>();
  const seen = new Map<string, number>();
  for (const row of masters.rows) {
    const k = `${row.lawd_cd}|${row.apt_name_norm}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    byName.set(k, String(row.complex_id));
  }
  for (const [k, n] of seen) if (n > 1) ambName.add(k);

  type C = { total: number; exact: number; labelSafe: number; labelAmb: number; none: number };
  const blank = (): C => ({ total: 0, exact: 0, labelSafe: 0, labelAmb: 0, none: 0 });
  const overall = blank();
  const by: Record<string, C> = { "20평대": blank(), "30평대": blank(), "40평대": blank() };

  for (const lawd of lawds) {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, floor FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND deal_amount>0 AND exclusive_area>0
              AND deal_date>='2025-09-17' AND deal_date<='2026-09-17'`,
      args: [lawd],
    });
    for (const row of rows.rows) {
      const nameKey = `${lawd}|${row.apt_name_norm}`;
      if (ambName.has(nameKey)) continue;
      const cid = byName.get(nameKey);
      if (!cid) continue;
      const area = num(row.exclusive_area);
      const ex = exclusiveCents(area);
      const pair = `${cid}|${ex}`;
      const fl = `${pair}|${num(row.floor)}`;
      let kind: keyof C = "none";
      if (exactKey.has(pair) || floor.has(fl)) kind = "exact";
      else if (labelClass.get(pair) === "LABEL_SAFE_MULTI") kind = "labelSafe";
      else if (labelClass.get(pair) === "LABEL_AMBIGUOUS") kind = "labelAmb";
      overall.total += 1;
      overall[kind] += 1;
      for (const [band, [min, max]] of Object.entries(BANDS)) {
        if (area < min || area > max) continue;
        by[band]!.total += 1;
        by[band]![kind] += 1;
      }
    }
  }

  function cov(c: C) {
    const market = c.total ? (c.exact + c.labelSafe) / c.total : 0;
    return { ...c, marketPyeongPriceCoverage: market };
  }

  const report = {
    rule: {
      version: PYEONG_LABEL_VERSION,
      helper: "marketPyeongLabelInteger = round(canonicalSupplyPyeong(supply_area))",
      canonicalSupplyPyeong: "round(supply_area/3.305785, 2)",
    },
    jamsilReference: {
      supply: 109.29,
      decimal: Math.round(jamsilDecimal * 100) / 100,
      canonical: jamsilCanon,
      label: jamsilLabel,
      label11152: label111,
      p1: Math.round(p1 * 10) / 10,
      p2: p2 != null ? Math.round(p2 * 10) / 10 : null,
      screenshot: 10076,
      p2minusScreenshot: p2 != null ? Math.round((p2 - 10076) * 10) / 10 : null,
    },
    boundarySensitiveVariants: boundary,
    pilots,
    seoul12: cov(overall),
    byCohort: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, cov(v)])),
  };
  writeFileSync("/tmp/building-hub-bulk/external-evidence/market-pyeong-audit.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    jamsilReference: report.jamsilReference,
    seoul12: report.seoul12,
    byCohort: report.byCohort,
    pilots: Object.fromEntries(Object.entries(pilots).map(([k, v]) => {
      const p = v as { sample: unknown; labelSafePairs: number; labelAmbiguousPairs: number };
      return [k, { sample: p.sample, safe: p.labelSafePairs, amb: p.labelAmbiguousPairs }];
    })),
  }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
