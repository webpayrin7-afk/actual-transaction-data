/**
 * Phase 7.1c — ≤10 sample cohort management-fee + basic-info fetch (V3/V5).
 *
 * Usage:
 *   npx tsx scripts/phase71c-sample-fee-apply.mts
 *   npx tsx scripts/phase71c-sample-fee-apply.mts --apply
 *
 * Never prints service key.
 */
import { createClient, type Client } from "@libsql/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = resolve(ROOT, "data/poc/phase71c");
const APPLY = process.argv.includes("--apply");
const BASE = "https://apis.data.go.kr/1613000";
const MAX_MONTHS = 12;
const SOURCE_KAPT = "KAPT";
const SOURCE_FEE = "MOLIT_KAPT_FEE_V3";
const SOURCE_BASIC = "MOLIT_KAPT_BASIC_V5";
const NOW = new Date().toISOString();

type CohortItem = {
  complex_id: string;
  apt_name: string;
  kapt_code: string | null;
};

type MasterRow = {
  complex_id: string;
  apt_name: string;
  apt_name_norm: string | null;
  lawd_cd: string | null;
  bjdong_cd: string | null;
};

/** 공용관리비 V3 line-item ops (원/단지·월). */
const COMMON_OPS = [
  "getHsmpCleaningCostInfoV3",
  "getHsmpGuardCostInfoV3",
  "getHsmpDisinfectCostInfoV3",
  "getHsmpElevatorCostInfoV3",
  "getHsmpLiquifiedTaxCostInfoV3",
  "getHsmpManageCostInfoV3",
  "getHsmpDomesticWasteCostInfoV3",
  "getHsmpMeetingCostInfoV3",
  "getHsmpBuildingInsuranceCostInfoV3",
  "getHsmpOtherCostInfoV3",
  "getHsmpElectricityCostInfoV3",
  "getHsmpWaterCostInfoV3",
  "getHsmpHeatingCostInfoV3",
  "getHsmpHotWaterCostInfoV3",
  "getHsmpGasCostInfoV3",
  "getHsmpPurificationCostInfoV3",
  "getHsmpLaborCostInfoV3",
] as const;

const INDIVIDUAL_OPS = [
  "getHsmpElectricityCostInfoV3",
  "getHsmpWaterCostInfoV3",
  "getHsmpHeatingCostInfoV3",
  "getHsmpHotWaterCostInfoV3",
  "getHsmpGasCostInfoV3",
] as const;

const INDIVIDUAL_FIELDS = [
  "electP",
  "electC",
  "waterCoolP",
  "waterCoolC",
  "heatP",
  "heatC",
  "waterHotP",
  "waterHotC",
  "gasP",
  "gasC",
] as const;

type JsonRec = Record<string, unknown>;

function loadEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function recentMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push(`${y}${String(m).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

function asRec(v: unknown): JsonRec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRec) : null;
}

function parsePayload(text: string): {
  resultCode: string | null;
  resultMsg: string | null;
  item: JsonRec | null;
  items: JsonRec[];
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(trimmed) as JsonRec;
      const response = asRec(j.response) ?? j;
      const header = asRec(response.header) ?? {};
      const body = asRec(response.body) ?? {};
      const resultCode =
        header.resultCode != null ? String(header.resultCode) : null;
      const resultMsg =
        header.resultMsg != null ? String(header.resultMsg) : null;
      const itemsNode = body.items;
      const itemNode = body.item;
      const items: JsonRec[] = [];
      if (Array.isArray(itemsNode)) {
        for (const x of itemsNode) {
          const r = asRec(x);
          if (r) items.push(r);
        }
      } else {
        const itemsObj = asRec(itemsNode);
        if (itemsObj) {
          const inner = itemsObj.item;
          if (Array.isArray(inner)) {
            for (const x of inner) {
              const r = asRec(x);
              if (r) items.push(r);
            }
          } else {
            const r = asRec(inner);
            if (r) items.push(r);
          }
        }
      }
      const item = asRec(itemNode) ?? items[0] ?? null;
      if (item && items.length === 0) items.push(item);
      return { resultCode, resultMsg, item, items };
    } catch {
      /* fall through */
    }
  }

  const resultCode = text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1] ?? null;
  const resultMsg = text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ?? null;
  const items: JsonRec[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[1]!;
    const rec: JsonRec = {};
    const tagRe = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(block))) {
      rec[t[1]!] = t[2]!;
    }
    items.push(rec);
  }
  return { resultCode, resultMsg, item: items[0] ?? null, items };
}

async function getJson(
  path: string,
  params: Record<string, string>,
  key: string,
): Promise<{
  http: number;
  resultCode: string | null;
  resultMsg: string | null;
  item: JsonRec | null;
  items: JsonRec[];
  ok: boolean;
}> {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set("serviceKey", key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  const parsed = parsePayload(text);
  const ok =
    res.ok &&
    (parsed.resultCode === "00" ||
      parsed.resultCode === "000" ||
      parsed.resultCode === "0" ||
      parsed.resultCode === "0000");
  return { http: res.status, ...parsed, ok };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sumNumericItem(item: JsonRec | null): number | null {
  if (!item) return null;
  let total = 0;
  let any = false;
  for (const [k, v] of Object.entries(item)) {
    if (k === "kaptCode" || /date|name|code/i.test(k)) continue;
    const n = num(v);
    if (n != null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

async function sumCommon(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  let total = 0;
  let any = false;
  for (const op of COMMON_OPS) {
    const r = await getJson(
      `/AptCmnuseManageCostServiceV3/${op}`,
      { kaptCode: kapt, searchDate: yyyymm },
      key,
    );
    await sleep(40);
    const part = sumNumericItem(r.ok ? r.item : null);
    if (part != null) {
      total += part;
      any = true;
    }
  }
  return any ? total : null;
}

async function sumIndividual(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  let total = 0;
  let any = false;
  for (const op of INDIVIDUAL_OPS) {
    const r = await getJson(
      `/AptIndvdlzManageCostServiceV3/${op}`,
      { kaptCode: kapt, searchDate: yyyymm },
      key,
    );
    await sleep(40);
    if (!r.ok || !r.item) continue;
    let part = 0;
    let partAny = false;
    for (const f of INDIVIDUAL_FIELDS) {
      if (!(f in r.item)) continue;
      const n = num(r.item[f]);
      if (n != null) {
        part += n;
        partAny = true;
      }
    }
    if (!partAny) {
      const fallback = sumNumericItem(r.item);
      if (fallback != null) {
        part = fallback;
        partAny = true;
      }
    }
    if (partAny) {
      total += part;
      any = true;
    }
  }
  return any ? total : null;
}

async function reserveLevy(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  const r = await getJson(
    "/AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3",
    { kaptCode: kapt, searchDate: yyyymm },
    key,
  );
  await sleep(40);
  if (!r.ok || !r.item) return null;
  return num(r.item.sLevy) ?? num(r.item.SLevy) ?? null;
}

/** Cheap month presence check before full common/individual fan-out. */
async function monthHasAnyFee(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<boolean> {
  const clean = await getJson(
    "/AptCmnuseManageCostServiceV3/getHsmpCleaningCostInfoV3",
    { kaptCode: kapt, searchDate: yyyymm },
    key,
  );
  await sleep(40);
  if (clean.ok && sumNumericItem(clean.item) != null) return true;
  const levy = await reserveLevy(kapt, yyyymm, key);
  return levy != null;
}

function nameMatch(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  return x.includes(y) || y.includes(x);
}

async function resolveKapt(
  cohort: CohortItem,
  master: MasterRow | undefined,
  key: string,
  existingLink: string | null,
): Promise<{ kapt: string | null; method: string }> {
  if (cohort.kapt_code) {
    return { kapt: cohort.kapt_code, method: "cohort" };
  }
  if (existingLink) {
    return { kapt: existingLink, method: "source_link" };
  }

  const lawd = master?.lawd_cd ?? null;
  const bjdong = master?.bjdong_cd ?? null;
  const target = master?.apt_name_norm ?? cohort.apt_name;

  if (lawd && bjdong) {
    const loadCode = `${lawd}${bjdong}`;
    const r = await getJson(
      "/AptListService4/getLegaldongAptList4",
      { loadCode, pageNo: "1", numOfRows: "100" },
      key,
    );
    await sleep(80);
    if (r.ok) {
      for (const it of r.items) {
        const name = String(it.kaptName ?? "");
        if (nameMatch(name, target)) {
          return { kapt: String(it.kaptCode), method: "legaldong_list" };
        }
      }
    }
  }

  if (lawd) {
    const r = await getJson(
      "/AptListService4/getSidoAptList4",
      { sidoCode: lawd.slice(0, 2), pageNo: "1", numOfRows: "1000" },
      key,
    );
    await sleep(100);
    if (r.ok) {
      for (const it of r.items) {
        const name = String(it.kaptName ?? "");
        if (nameMatch(name, target)) {
          return { kapt: String(it.kaptCode), method: "sido_list" };
        }
      }
    }
  }

  return { kapt: null, method: "unresolved" };
}

async function ensureKaptLink(
  db: Client,
  complexId: string,
  kapt: string,
): Promise<number> {
  const ex = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_source_links
          WHERE source = ? AND source_key = ? LIMIT 1`,
    args: [SOURCE_KAPT, kapt],
  });
  if (ex.rows.length) {
    const cur = String(ex.rows[0]!.complex_id);
    if (cur === complexId) return 0;
  }
  await db.execute({
    sql: `INSERT INTO apt_complex_source_links
            (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, source_key) DO UPDATE SET
            complex_id=excluded.complex_id,
            source_meta_json=excluded.source_meta_json,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at`,
    args: [
      SOURCE_KAPT,
      kapt,
      complexId,
      JSON.stringify({ phase: "7.1c", match: "sample" }),
      "AptListService4/AptBasisInfoServiceV5",
      NOW,
      NOW,
    ],
  });
  return 1;
}

async function upsertFee(
  db: Client,
  complexId: string,
  yyyymm: string,
  common: number | null,
  individual: number | null,
  reserve: number | null,
  householdBasis: number | null,
): Promise<number> {
  if (common == null && individual == null && reserve == null) return 0;
  const total =
    (common ?? 0) + (individual ?? 0) + (reserve ?? 0) > 0 ||
    common != null ||
    individual != null ||
    reserve != null
      ? (common ?? 0) + (individual ?? 0) + (reserve ?? 0)
      : null;
  // total is LABEL-ONLY composite when parts exist
  const totalFee =
    common != null || individual != null || reserve != null
      ? (common ?? 0) + (individual ?? 0) + (reserve ?? 0)
      : null;

  await db.execute({
    sql: `INSERT INTO apt_complex_mgmt_fee_monthly (
            complex_id, period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
            total_fee, per_area_common_fee, per_area_total_fee, area_basis_sqm,
            household_basis, amount_basis, source, source_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, period_yyyymm) DO UPDATE SET
            common_fee=excluded.common_fee,
            individual_fee=excluded.individual_fee,
            long_term_repair_reserve=excluded.long_term_repair_reserve,
            total_fee=excluded.total_fee,
            household_basis=excluded.household_basis,
            amount_basis=excluded.amount_basis,
            source=excluded.source,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at`,
    args: [
      complexId,
      yyyymm,
      common,
      individual,
      reserve,
      totalFee,
      householdBasis,
      "complex_month_total_krw",
      SOURCE_FEE,
      "AptCmnuse/AptIndvdlz/AptRepairs V3",
      NOW,
    ],
  });
  void total;
  return 1;
}

async function upsertProfileFromKapt(
  db: Client,
  complexId: string,
  basic: JsonRec | null,
  detail: JsonRec | null,
): Promise<number> {
  if (!basic && !detail) return 0;
  const b = basic ?? {};
  const d = detail ?? {};
  const household = num(b.kaptdaCnt) ?? num(d.kaptdaCnt) ?? null;
  const parking = num(d.parkingCnt) ?? num(b.parkingCnt) ?? null;
  const heat =
    (d.codeHeatNm != null ? String(d.codeHeatNm) : null) ??
    (b.codeHeatNm != null ? String(b.codeHeatNm) : null);
  const manage =
    (d.codeMgrNm != null ? String(d.codeMgrNm) : null) ??
    (b.codeMgrNm != null ? String(b.codeMgrNm) : null);
  const approval =
    (b.kaptUsedate != null ? String(b.kaptUsedate) : null) ??
    (d.kaptUsedate != null ? String(d.kaptUsedate) : null);
  const buildings = num(b.kaptDongCnt) ?? num(d.kaptDongCnt) ?? null;

  const ex = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_profile WHERE complex_id = ? LIMIT 1`,
    args: [complexId],
  });

  if (ex.rows.length) {
    await db.execute({
      sql: `UPDATE apt_complex_profile SET
              household_count = COALESCE(?, household_count),
              building_count = COALESCE(?, building_count),
              approval_date = COALESCE(?, approval_date),
              heating_type = COALESCE(?, heating_type),
              management_type = COALESCE(?, management_type),
              parking_total = COALESCE(?, parking_total),
              source = CASE
                WHEN source IS NULL OR source = '' THEN ?
                WHEN source = ? THEN ?
                ELSE source
              END,
              source_version = COALESCE(source_version, ?) || '',
              updated_at = ?
            WHERE complex_id = ?`,
      args: [
        household,
        buildings,
        approval,
        heat,
        manage,
        parking,
        SOURCE_BASIC,
        "COMPOSITE",
        "COMPOSITE",
        SOURCE_BASIC,
        NOW,
        complexId,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO apt_complex_profile (
              complex_id, household_count, building_count, approval_date, heating_type,
              management_type, parking_total, source, source_version, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        complexId,
        household,
        buildings,
        approval,
        heat,
        manage,
        parking,
        SOURCE_BASIC,
        "AptBasisInfoServiceV5",
        NOW,
      ],
    });
  }
  return 1;
}

async function setEnrichment(
  db: Client,
  complexId: string,
  domain: string,
  status: "READY" | "PENDING",
  reason: string | null,
): Promise<number> {
  const ex = await db.execute({
    sql: `SELECT status FROM apt_complex_enrichment_state
          WHERE complex_id = ? AND domain = ? LIMIT 1`,
    args: [complexId, domain],
  });
  if (ex.rows.length) {
    const cur = String(ex.rows[0]!.status);
    // Never downgrade READY → PENDING in this phase.
    if (cur === "READY" && status !== "READY") return 0;
    await db.execute({
      sql: `UPDATE apt_complex_enrichment_state SET
              status = ?, reason_code = ?, processed_at = ?,
              source_updated_at = CASE WHEN ? = 'READY' THEN ? ELSE source_updated_at END,
              updated_at = ?
            WHERE complex_id = ? AND domain = ?`,
      args: [status, reason, NOW, status, NOW, NOW, complexId, domain],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO apt_complex_enrichment_state
              (complex_id, domain, status, reason_code, data_version, processed_at, source_updated_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      args: [
        complexId,
        domain,
        status,
        reason,
        NOW,
        status === "READY" ? NOW : null,
        NOW,
      ],
    });
  }
  return 1;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const key = requireEnv("MOLIT_API_KEY");
  const db = createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
  });
  mkdirSync(OUT_DIR, { recursive: true });

  const cohort = JSON.parse(
    readFileSync(resolve(ROOT, "data/poc/phase71/sample-cohort.json"), "utf8"),
  ) as { complexes: CohortItem[] };
  if (cohort.complexes.length > 10) throw new Error(">10 sample");

  const ids = cohort.complexes.map((c) => c.complex_id);
  const ph = ids.map(() => "?").join(",");
  const masters = await db.execute({
    sql: `SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd
          FROM apt_complex_master WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const masterById = new Map<string, MasterRow>();
  for (const r of masters.rows) {
    masterById.set(String(r.complex_id), {
      complex_id: String(r.complex_id),
      apt_name: String(r.apt_name),
      apt_name_norm: r.apt_name_norm != null ? String(r.apt_name_norm) : null,
      lawd_cd: r.lawd_cd != null ? String(r.lawd_cd) : null,
      bjdong_cd: r.bjdong_cd != null ? String(r.bjdong_cd) : null,
    });
  }

  const links = await db.execute({
    sql: `SELECT complex_id, source_key FROM apt_complex_source_links
          WHERE source = ? AND complex_id IN (${ph})`,
    args: [SOURCE_KAPT, ...ids],
  });
  const kaptByComplex = new Map<string, string>();
  for (const r of links.rows) {
    kaptByComplex.set(String(r.complex_id), String(r.source_key));
  }

  const months = recentMonths(MAX_MONTHS);
  const writes = {
    source_links: 0,
    profile: 0,
    management_rows: 0,
    state_rows: 0,
  };

  const results: Array<Record<string, unknown>> = [];
  let feeComplexes = 0;
  let feeMonths = 0;
  let basicOk = 0;

  const semantics = {
    unit: "KRW",
    monthly_basis: "per complex-month (단지 월 합계)",
    common_basis:
      "sum of AptCmnuseManageCostServiceV3 line-item ops (청소/경비/소독/승강기/…)",
    individual_basis:
      "sum of AptIndvdlzManageCostServiceV3 utility ops (전기/수도/난방/급탕/가스 P+C)",
    reserve_basis: "getHsmpMonthFeeInfoV3.sLevy (월부과액)",
    summable:
      "LABEL-ONLY composite = common + individual + reserve; not an official single field",
    per_m2: "DERIVABLE-WITH-CONDITION (needs official exclusive area basis; not invented)",
    per_household:
      "DERIVABLE-WITH-CONDITION (divide by kaptdaCnt / household_count when present)",
    selected_pyeong:
      "UNSAFE — no official selected-pyeong fee; do not invent from area groups",
  };

  for (const item of cohort.complexes) {
    const master = masterById.get(item.complex_id);
    const resolved = await resolveKapt(
      item,
      master,
      key,
      kaptByComplex.get(item.complex_id) ?? null,
    );
    const entry: Record<string, unknown> = {
      complex_id: item.complex_id,
      apt_name: item.apt_name,
      kaptCode: resolved.kapt,
      resolve_method: resolved.method,
      basic_ok: false,
      fee_months: 0,
      months: [] as Array<Record<string, unknown>>,
    };

    if (!resolved.kapt) {
      entry.skip = "NO_KAPT";
      results.push(entry);
      continue;
    }

    if (APPLY) {
      writes.source_links += await ensureKaptLink(
        db,
        item.complex_id,
        resolved.kapt,
      );
    }

    const bass = await getJson(
      "/AptBasisInfoServiceV5/getAphusBassInfoV5",
      { kaptCode: resolved.kapt },
      key,
    );
    await sleep(60);
    const dtl = await getJson(
      "/AptBasisInfoServiceV5/getAphusDtlInfoV5",
      { kaptCode: resolved.kapt },
      key,
    );
    await sleep(60);
    entry.basic_ok = bass.ok;
    entry.basic_result = bass.resultCode;
    entry.detail_ok = dtl.ok;
    const household =
      num(bass.item?.kaptdaCnt) ?? num(dtl.item?.kaptdaCnt) ?? null;
    entry.household_count = household;

    if (bass.ok) {
      basicOk++;
      if (APPLY) {
        writes.profile += await upsertProfileFromKapt(
          db,
          item.complex_id,
          bass.item,
          dtl.ok ? dtl.item : null,
        );
        writes.state_rows += await setEnrichment(
          db,
          item.complex_id,
          "BASIC_INFO",
          "READY",
          null,
        );
      }
    }

    let monthHits = 0;
    const monthRows: Array<Record<string, unknown>> = [];
    for (const ym of months) {
      const present = await monthHasAnyFee(resolved.kapt, ym, key);
      if (!present) {
        monthRows.push({ year_month: ym, skipped: "empty_probe" });
        continue;
      }
      // Cleaning already counted in probe; still full-sum for accuracy.
      const common = await sumCommon(resolved.kapt, ym, key);
      const individual = await sumIndividual(resolved.kapt, ym, key);
      const reserve = await reserveLevy(resolved.kapt, ym, key);
      if (common == null && individual == null && reserve == null) {
        monthRows.push({ year_month: ym, skipped: "empty_after_sum" });
        continue;
      }
      monthHits++;
      feeMonths++;
      const row = {
        year_month: ym,
        common_fee: common,
        individual_fee: individual,
        long_term_repair_reserve: reserve,
        label_total:
          (common ?? 0) + (individual ?? 0) + (reserve ?? 0),
        per_household_label:
          household && household > 0
            ? Math.round(
                ((common ?? 0) + (individual ?? 0) + (reserve ?? 0)) /
                  household,
              )
            : null,
      };
      monthRows.push(row);
      if (APPLY) {
        writes.management_rows += await upsertFee(
          db,
          item.complex_id,
          ym,
          common,
          individual,
          reserve,
          household,
        );
      }
    }
    entry.fee_months = monthHits;
    entry.months = monthRows;
    if (monthHits > 0) {
      feeComplexes++;
      if (APPLY) {
        writes.state_rows += await setEnrichment(
          db,
          item.complex_id,
          "MANAGEMENT_FEE",
          "READY",
          null,
        );
      }
    }

    results.push(entry);
    console.log(
      JSON.stringify({
        apt: item.apt_name,
        kapt: resolved.kapt,
        method: resolved.method,
        basic: bass.ok,
        fee_months: monthHits,
      }),
    );
  }

  const report = {
    phase: "7.1c-sample-fee",
    mode: APPLY ? "apply" : "dry-run",
    generated_at: NOW,
    months_requested: months,
    semantics,
    summary: {
      complexes: results.length,
      with_kapt: results.filter((r) => r.kaptCode).length,
      basic_ok: basicOk,
      fee_complexes: feeComplexes,
      fee_months: feeMonths,
    },
    writes,
    results,
  };

  const out = resolve(
    OUT_DIR,
    APPLY ? "sample-fee-apply.json" : "sample-fee-dryrun.json",
  );
  writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        out,
        summary: report.summary,
        writes: report.writes,
        note: "serviceKey redacted",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
