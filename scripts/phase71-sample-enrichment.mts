#!/usr/bin/env npx tsx
/**
 * Phase 7.1 sample enrichment loader (≤10 complexes).
 * Default: dry-run. Pass --apply to write.
 */
import { createClient, type Client } from "@libsql/client";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "data/poc/phase71");
const APPLY = process.argv.includes("--apply");
mkdirSync(OUT, { recursive: true });

type CohortItem = {
  complex_id: string;
  apt_name: string;
  role: string;
  kapt_code: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function padBunJi(jibun: string) {
  const raw = jibun.replace(/^산\s*/, "").trim();
  const [a, b] = raw.split("-");
  return {
    bun: String(Number(a || 0)).padStart(4, "0"),
    ji: String(Number(b || 0)).padStart(4, "0"),
  };
}

function loadKapt(code: string) {
  const p = join(ROOT, `data/poc/phase45/cache/kapt_${code}.json`);
  if (!existsSync(p)) return null;
  const d = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  return {
    kaptCode: String(d.kaptCode ?? code),
    kaptName: d.kaptName == null ? null : String(d.kaptName),
    households: d.households == null ? null : Number(d.households),
    dongCnt: d.dong_cnt == null ? null : Number(d.dong_cnt),
    useDate: d.use_date == null ? null : String(d.use_date),
  };
}

async function fetchBrTitle(params: {
  sigunguCd: string;
  bjdongCd: string;
  bun: string;
  ji: string;
}) {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const qs = new URLSearchParams({
    serviceKey: key,
    sigunguCd: params.sigunguCd,
    bjdongCd: params.bjdongCd,
    platGbCd: "0",
    bun: params.bun,
    ji: params.ji,
    numOfRows: "100",
    pageNo: "1",
  });
  const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${qs}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ziplab-phase71" },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseItems(xml: string) {
  const items: Record<string, string>[] = [];
  for (const block of xml.split(/<item>/).slice(1)) {
    const body = block.split(/<\/item>/)[0] ?? "";
    const row: Record<string, string> = {};
    for (const m of body.matchAll(/<([a-zA-Z0-9]+)>([^<]*)<\/\1>/g)) {
      row[m[1]] = m[2];
    }
    items.push(row);
  }
  return items;
}

function aggregateTitle(items: Record<string, string>[], aptName: string) {
  const target = aptName.replace(/\s+/g, "").replace(/아파트$/, "");
  const matched = items.filter((it) => {
    const nm = (it.bldNm || "").replace(/\s+/g, "");
    return !nm || nm.includes(target) || target.includes(nm);
  });
  const use = matched.length ? matched : items;
  let household = 0;
  let maxFloor = 0;
  let approval: string | null = null;
  let structure: string | null = null;
  let purpose: string | null = null;
  let totalArea = 0;
  for (const it of use) {
    household += Number(it.hhldCnt || 0);
    maxFloor = Math.max(maxFloor, Number(it.grndFlrCnt || 0));
    const d = it.useAprDay || "";
    if (!approval && d.length === 8) {
      approval = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }
    if (!structure && it.strctCdNm) structure = it.strctCdNm;
    if (!purpose && it.mainPurpsCdNm) purpose = it.mainPurpsCdNm;
    totalArea += Number(it.totArea || 0);
  }
  return {
    household_count: household || null,
    building_count: use.length || null,
    approval_date: approval,
    max_floor: maxFloor || null,
    structure_type: structure,
    main_purpose: purpose,
    total_area_sqm: totalArea || null,
    title_rows: use.length,
  };
}

async function upsertLink(
  db: Client,
  source: string,
  sourceKey: string,
  complexId: string,
  meta: unknown,
  version: string,
) {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO apt_complex_source_links
            (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, source_key) DO UPDATE SET
            complex_id=excluded.complex_id,
            source_meta_json=excluded.source_meta_json,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at`,
    args: [source, sourceKey, complexId, JSON.stringify(meta), version, ts, ts],
  });
}

async function upsertEnrichment(db: Client, complexId: string, domain: string) {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO apt_complex_enrichment_state
            (complex_id, domain, status, reason_code, data_version, processed_at, source_updated_at, updated_at)
          VALUES (?, ?, 'READY', NULL, 1, ?, ?, ?)
          ON CONFLICT(complex_id, domain) DO UPDATE SET
            status='READY', reason_code=NULL, data_version=1,
            processed_at=excluded.processed_at, updated_at=excluded.updated_at`,
    args: [complexId, domain, ts, ts, ts],
  });
}

async function main() {
  const cohort = JSON.parse(
    readFileSync(join(OUT, "sample-cohort.json"), "utf8"),
  ) as { complexes: CohortItem[] };
  if (cohort.complexes.length > 10) throw new Error(">10 sample");

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const migration = readFileSync(
    join(ROOT, "src/lib/db/migrations/20260912_complex_detail_v1.sql"),
    "utf8",
  );

  const plan: Record<string, unknown> = {
    mode: APPLY ? "APPLY" : "DRY-RUN",
    blockers: [
      "KAPT / management-fee OpenAPI unavailable with current MOLIT_API_KEY (NO_OPENAPI_SERVICE_ERROR)",
    ],
    expected: {
      profile_upserts: 0,
      source_link_upserts: 0,
      enrichment_upserts: 0,
      mgmt_fee_upserts: 0,
    },
    api_requests: { building_hub: 0, kapt_live: 0, mgmt_live: 0 },
    complexes: [] as Record<string, unknown>[],
  };
  const expected = plan.expected as Record<string, number>;
  const api = plan.api_requests as Record<string, number>;
  const complexes = plan.complexes as Record<string, unknown>[];

  if (APPLY) {
    // Execute migration as discrete statements (avoid comment/split pitfalls).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS apt_complex_profile (
        complex_id TEXT PRIMARY KEY REFERENCES apt_complex_master(complex_id),
        household_count INTEGER,
        building_count INTEGER,
        approval_date TEXT,
        heating_type TEXT,
        management_type TEXT,
        parking_total INTEGER,
        parking_per_household REAL,
        far_ratio REAL,
        bcr_ratio REAL,
        max_floor INTEGER,
        land_area_sqm REAL,
        total_area_sqm REAL,
        structure_type TEXT,
        main_purpose TEXT,
        source TEXT NOT NULL,
        source_version TEXT,
        raw_meta_json TEXT,
        updated_at TEXT NOT NULL
      )`);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_acp_approval ON apt_complex_profile (approval_date)`,
    );
    await db.execute(`
      CREATE TABLE IF NOT EXISTS apt_complex_mgmt_fee_monthly (
        complex_id TEXT NOT NULL REFERENCES apt_complex_master(complex_id),
        period_yyyymm TEXT NOT NULL,
        common_fee INTEGER,
        individual_fee INTEGER,
        long_term_repair_reserve INTEGER,
        total_fee INTEGER,
        per_area_common_fee REAL,
        per_area_total_fee REAL,
        area_basis_sqm REAL,
        household_basis INTEGER,
        amount_basis TEXT,
        source TEXT NOT NULL,
        source_version TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (complex_id, period_yyyymm)
      )`);
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_acmfm_period ON apt_complex_mgmt_fee_monthly (period_yyyymm)`,
    );
    void migration; // kept on disk as source of truth
  }

  for (const c of cohort.complexes) {
    const m = await db.execute({
      sql: `SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun
            FROM apt_complex_master WHERE complex_id = ?`,
      args: [c.complex_id],
    });
    const master = m.rows[0] as
      | {
          complex_id: string;
          apt_name: string;
          apt_name_norm: string;
          lawd_cd: string;
          bjdong_cd: string | null;
          jibun: string | null;
        }
      | undefined;
    if (!master) {
      complexes.push({
        complex_id: c.complex_id,
        apt_name: c.apt_name,
        status: "SOURCE-ID-UNRESOLVED",
      });
      continue;
    }

    const entry: Record<string, unknown> = {
      complex_id: master.complex_id,
      apt_name: master.apt_name,
      role: c.role,
      kapt_code: c.kapt_code,
      sources: [] as string[],
    };
    const sources = entry.sources as string[];

    const sale = await db.execute({
      sql: `SELECT deal_date, deal_amount, exclusive_area, floor
            FROM transactions
            WHERE lawd_cd = ? AND apt_name_norm = ? AND deal_type = 'trade'
            ORDER BY deal_date DESC LIMIT 1`,
      args: [master.lawd_cd, master.apt_name_norm],
    });
    const jeonse = await db.execute({
      sql: `SELECT deal_date, deal_amount, exclusive_area, floor
            FROM transactions
            WHERE lawd_cd = ? AND apt_name_norm = ? AND deal_type = 'rent'
              AND IFNULL(monthly_rent, 0) = 0
            ORDER BY deal_date DESC LIMIT 1`,
      args: [master.lawd_cd, master.apt_name_norm],
    });
    const saleRow = sale.rows[0] as
      | { deal_date: string; deal_amount: number; exclusive_area: number; floor: number }
      | undefined;
    const jeonseRow = jeonse.rows[0] as
      | { deal_date: string; deal_amount: number; exclusive_area: number; floor: number }
      | undefined;
    entry.market_probe = {
      latest_sale: saleRow ?? null,
      latest_jeonse: jeonseRow ?? null,
      jeonse_ratio:
        saleRow && jeonseRow && saleRow.deal_amount > 0
          ? Number((jeonseRow.deal_amount / saleRow.deal_amount).toFixed(4))
          : null,
      sale_jeonse_gap:
        saleRow && jeonseRow ? saleRow.deal_amount - jeonseRow.deal_amount : null,
    };

    const profile: Record<string, unknown> = {
      complex_id: master.complex_id,
      household_count: null,
      building_count: null,
      approval_date: null,
      heating_type: null,
      management_type: null,
      parking_total: null,
      parking_per_household: null,
      far_ratio: null,
      bcr_ratio: null,
      max_floor: null,
      land_area_sqm: null,
      total_area_sqm: null,
      structure_type: null,
      main_purpose: null,
      source: "COMPOSITE",
      source_version: "phase71-v1",
      raw_meta_json: null,
      updated_at: nowIso(),
    };

    if (c.kapt_code) {
      const kapt = loadKapt(c.kapt_code);
      if (kapt) {
        sources.push("KAPT_POC_CACHE");
        profile.household_count = kapt.households;
        profile.building_count = kapt.dongCnt;
        profile.approval_date = kapt.useDate;
        expected.source_link_upserts += 1;
        if (APPLY) {
          await upsertLink(db, "KAPT", c.kapt_code, master.complex_id, {
            kaptName: kapt.kaptName,
          }, "poc-phase45");
        }
      }
    }

    if (master.bjdong_cd && master.jibun) {
      const { bun, ji } = padBunJi(master.jibun);
      try {
        api.building_hub += 1;
        const xml = await fetchBrTitle({
          sigunguCd: master.lawd_cd,
          bjdongCd: master.bjdong_cd,
          bun,
          ji,
        });
        const agg = aggregateTitle(parseItems(xml), master.apt_name);
        sources.push("BUILDING_HUB");
        profile.household_count = profile.household_count ?? agg.household_count;
        profile.building_count = profile.building_count ?? agg.building_count;
        profile.approval_date = profile.approval_date ?? agg.approval_date;
        profile.max_floor = agg.max_floor;
        profile.structure_type = agg.structure_type;
        profile.main_purpose = agg.main_purpose;
        profile.total_area_sqm = agg.total_area_sqm;
        profile.raw_meta_json = JSON.stringify({
          hub_title_rows: agg.title_rows,
          parcel: `${master.lawd_cd}|${master.bjdong_cd}|${bun}|${ji}`,
        });
        const parcelKey = `${master.lawd_cd}${master.bjdong_cd}0${bun}${ji}`;
        expected.source_link_upserts += 1;
        if (APPLY) {
          await upsertLink(
            db,
            "BUILDING_HUB_PARCEL",
            parcelKey,
            master.complex_id,
            { title_rows: agg.title_rows },
            "getBrTitleInfo",
          );
        }
      } catch (e) {
        entry.hub_error = String(e);
      }
    }

    entry.profile = profile;
    expected.profile_upserts += 1;
    expected.enrichment_upserts += 2;

    if (APPLY) {
      await db.execute({
        sql: `INSERT INTO apt_complex_profile (
            complex_id, household_count, building_count, approval_date, heating_type,
            management_type, parking_total, parking_per_household, far_ratio, bcr_ratio,
            max_floor, land_area_sqm, total_area_sqm, structure_type, main_purpose,
            source, source_version, raw_meta_json, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(complex_id) DO UPDATE SET
            household_count=excluded.household_count,
            building_count=excluded.building_count,
            approval_date=excluded.approval_date,
            heating_type=excluded.heating_type,
            management_type=excluded.management_type,
            parking_total=excluded.parking_total,
            parking_per_household=excluded.parking_per_household,
            far_ratio=excluded.far_ratio,
            bcr_ratio=excluded.bcr_ratio,
            max_floor=excluded.max_floor,
            land_area_sqm=excluded.land_area_sqm,
            total_area_sqm=excluded.total_area_sqm,
            structure_type=excluded.structure_type,
            main_purpose=excluded.main_purpose,
            source=excluded.source,
            source_version=excluded.source_version,
            raw_meta_json=excluded.raw_meta_json,
            updated_at=excluded.updated_at`,
        args: [
          profile.complex_id,
          profile.household_count,
          profile.building_count,
          profile.approval_date,
          profile.heating_type,
          profile.management_type,
          profile.parking_total,
          profile.parking_per_household,
          profile.far_ratio,
          profile.bcr_ratio,
          profile.max_floor,
          profile.land_area_sqm,
          profile.total_area_sqm,
          profile.structure_type,
          profile.main_purpose,
          profile.source,
          profile.source_version,
          profile.raw_meta_json,
          profile.updated_at,
        ],
      });
      await upsertEnrichment(db, master.complex_id, "BASIC_INFO");
      await upsertEnrichment(db, master.complex_id, "BUILDING_INFO");
    }

    complexes.push(entry);
    console.log(`OK ${master.apt_name} sources=${sources.join(",") || "-"}`);
  }

  const outFile = join(OUT, APPLY ? "apply-report.json" : "dry-run-report.json");
  writeFileSync(outFile, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ mode: plan.mode, expected: plan.expected, api: plan.api_requests }, null, 2));
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
