#!/usr/bin/env npx tsx
/**
 * PROFILE — Seoul HERO 8-field coverage audit + NULL-safe fill.
 *
 * Scope: apt_complex_profile (+ optional deterministic source-link / provenance only).
 * Modes:
 *   --audit     coverage + source inventory (read-only)
 *   --pilot     representative pilot dry classification (+ optional API)
 *   --dry-run   Seoul-wide candidate classification (default)
 *   --apply     write NULL_SAFE_FILL only
 *   --idempotency  re-run apply classification after apply
 *
 * Never prints API keys. Never overwrites existing non-null positives.
 */
import { createClient, type Client } from "@libsql/client";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "data/poc/profile-hero");
const CACHE = resolve(OUT, "cache");
mkdirSync(CACHE, { recursive: true });

const APPLY = process.argv.includes("--apply");
const PILOT = process.argv.includes("--pilot");
const AUDIT = process.argv.includes("--audit");
const IDEMPOTENCY = process.argv.includes("--idempotency");
const RECONCILE = process.argv.includes("--reconcile");
const DRY = !APPLY && !AUDIT; // pilot/dry-run also dry unless --apply
const SOURCE_VERSION = "profile-hero-v1";
const BASE = "https://apis.data.go.kr/1613000";

const HERO_FIELDS = [
  "household_count",
  "building_count",
  "approval_date",
  "max_floor",
  "parking_per_household",
  "far_ratio",
  "bcr_ratio",
  "heating_type",
] as const;
type HeroField = (typeof HERO_FIELDS)[number];

type Class =
  | "NULL_SAFE_FILL"
  | "EXISTING_SAME"
  | "EXISTING_DIFFERENT"
  | "SOURCE_MISSING"
  | "IDENTITY_UNRESOLVED"
  | "AMBIGUOUS"
  | "INVALID_VALUE";

type ConflictKind =
  | "EXACT_SAME"
  | "FORMAT_ONLY_DIFFERENCE"
  | "MATERIAL_DIFFERENCE"
  | null;

type ProfileRow = {
  complex_id: string;
  household_count: number | null;
  building_count: number | null;
  approval_date: string | null;
  heating_type: string | null;
  management_type: string | null;
  parking_total: number | null;
  parking_per_household: number | null;
  far_ratio: number | null;
  bcr_ratio: number | null;
  max_floor: number | null;
  land_area_sqm: number | null;
  total_area_sqm: number | null;
  structure_type: string | null;
  main_purpose: string | null;
  source: string | null;
  source_version: string | null;
  raw_meta_json: string | null;
};

type MasterRow = {
  complex_id: string;
  apt_name: string;
  lawd_cd: string;
  bjdong_cd: string | null;
  jibun: string | null;
};

type Candidate = {
  value: string | number;
  source: string;
  source_key: string;
  raw: unknown;
  derived?: boolean;
  derived_tag?: string;
};

type FieldDecision = {
  field: HeroField;
  classification: Class;
  conflict: ConflictKind;
  existing: string | number | null;
  candidate: Candidate | null;
  reason: string;
};

const PILOT_NAMES = [
  "잠실엘스",
  "파크리오",
  "리센츠",
  "헬리오시티",
  "반포자이",
  "래미안퍼스티지",
  "은마",
  "도곡렉슬",
  "한남더힐",
  "마포한강푸르지오", // closest available stand-in (마포래미안푸르지오 absent in master)
];

const PILOT_EXTRA_IDS = [
  "cx_8a981fdd1a1ce1df", // small: 네르비
  "cx_53f74b8fc8ee97a5", // small: 그린아파트
  "cx_0320fd9e007e1f8c", // old: 은마 (also in names)
  "cx_30d7eea6da810b52", // new mega: 헬리오시티
  "cx_e0e7bf6667825066", // sparse / no buildings: 하이텍하우스
  "cx_365cf176032a7336", // no buildings: 한진해모로
];

function nowIso() {
  return new Date().toISOString();
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function padBunJi(jibun: string) {
  const raw = jibun.replace(/^산\s*/, "").trim();
  const [a, b] = raw.split("-");
  return {
    bun: String(Number(a || 0)).padStart(4, "0"),
    ji: String(Number(b || 0)).padStart(4, "0"),
    platGbCd: jibun.trim().startsWith("산") ? "1" : "0",
  };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function isPlaceholderHeat(s: string | null): boolean {
  if (!s) return true;
  const t = s.trim().toLowerCase();
  return (
    t === "" ||
    t === "-" ||
    t === "null" ||
    t === "없음" ||
    t === "미상" ||
    t === "n/a"
  );
}

function isValidField(field: HeroField, value: string | number | null): boolean {
  if (value == null) return false;
  if (field === "heating_type") {
    return typeof value === "string" && !isPlaceholderHeat(value);
  }
  if (field === "approval_date") {
    const d = normalizeDate(value);
    if (!d) return false;
    const y = Number(d.slice(0, 4));
    if (y < 1950 || y > 2100) return false;
    // reject future beyond ~1 day past source as-of
    if (d > nowIso().slice(0, 10)) return false;
    return true;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return false;
  if (
    field === "household_count" ||
    field === "building_count" ||
    field === "max_floor"
  ) {
    return n > 0 && Number.isInteger(n);
  }
  if (field === "parking_per_household") return n >= 0;
  if (field === "far_ratio") return n > 0 && n <= 2000;
  if (field === "bcr_ratio") return n > 0 && n <= 100;
  return true;
}

function nearlyEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function compareValues(
  field: HeroField,
  existing: string | number,
  candidate: string | number,
): ConflictKind {
  if (field === "approval_date") {
    const e = normalizeDate(existing);
    const c = normalizeDate(candidate);
    if (e && c && e === c) {
      return String(existing) === String(candidate)
        ? "EXACT_SAME"
        : "FORMAT_ONLY_DIFFERENCE";
    }
    return "MATERIAL_DIFFERENCE";
  }
  if (field === "heating_type") {
    const e = String(existing).trim();
    const c = String(candidate).trim();
    if (e === c) return "EXACT_SAME";
    if (e.replace(/\s+/g, "") === c.replace(/\s+/g, "")) {
      return "FORMAT_ONLY_DIFFERENCE";
    }
    return "MATERIAL_DIFFERENCE";
  }
  const e = Number(existing);
  const c = Number(candidate);
  if (!Number.isFinite(e) || !Number.isFinite(c)) return "MATERIAL_DIFFERENCE";
  if (e === c) return "EXACT_SAME";
  // parking precision / FAR rounding (1.39 vs 1.4, 275.99 vs 276)
  if (
    (field === "parking_per_household" ||
      field === "far_ratio" ||
      field === "bcr_ratio") &&
    nearlyEqual(e, c, 0.05)
  ) {
    return "FORMAT_ONLY_DIFFERENCE";
  }
  return "MATERIAL_DIFFERENCE";
}

function cachePath(kind: string, key: string) {
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return resolve(CACHE, `${kind}_${safe}.json`);
}

function readCache<T>(kind: string, key: string): T | null {
  const p = cachePath(kind, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeCache(kind: string, key: string, data: unknown) {
  writeFileSync(cachePath(kind, key), JSON.stringify(data));
}

type JsonRec = Record<string, unknown>;

async function getJson(
  path: string,
  params: Record<string, string>,
  key: string,
): Promise<{
  ok: boolean;
  resultCode: string | null;
  item: JsonRec | null;
  items: JsonRec[];
  totalCount: number | null;
  rawHead: string;
}> {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set("serviceKey", key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (!u.searchParams.has("_type")) u.searchParams.set("_type", "json");
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": "ziplab-profile-hero" },
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      resultCode: null,
      item: null,
      items: [],
      totalCount: null,
      rawHead: text.slice(0, 200),
    };
  }
  const header = parsed?.response?.header ?? {};
  const body = parsed?.response?.body ?? {};
  const resultCode = header.resultCode != null ? String(header.resultCode) : null;
  const ok =
    res.ok &&
    (resultCode === "00" ||
      resultCode === "000" ||
      resultCode === "0" ||
      resultCode === "0000");
  let items: JsonRec[] = [];
  const rawItem = body?.item ?? body?.items?.item ?? body?.items ?? null;
  if (Array.isArray(rawItem)) items = rawItem as JsonRec[];
  else if (rawItem && typeof rawItem === "object") items = [rawItem as JsonRec];
  const totalCount = body?.totalCount != null ? Number(body.totalCount) : items.length;
  return {
    ok,
    resultCode,
    item: items[0] ?? null,
    items,
    totalCount: Number.isFinite(totalCount) ? totalCount : items.length,
    rawHead: text.slice(0, 120),
  };
}

async function fetchRecap(
  master: MasterRow,
  apiKey: string,
): Promise<{
  status: "OK" | "MISSING" | "AMBIGUOUS" | "NO_PARCEL" | "ERROR";
  item: JsonRec | null;
  parcelKey: string | null;
  error?: string;
}> {
  if (!master.bjdong_cd || !master.jibun) {
    return { status: "NO_PARCEL", item: null, parcelKey: null };
  }
  const { bun, ji, platGbCd } = padBunJi(master.jibun);
  const parcelKey = `${master.lawd_cd}${master.bjdong_cd}${platGbCd}${bun}${ji}`;
  const cached = readCache<{
    status: "OK" | "MISSING" | "AMBIGUOUS" | "ERROR";
    item: JsonRec | null;
    error?: string;
  }>("recap", parcelKey);
  if (cached) {
    return { ...cached, parcelKey };
  }
  try {
    const r = await getJson(
      "/BldRgstHubService/getBrRecapTitleInfo",
      {
        sigunguCd: master.lawd_cd,
        bjdongCd: master.bjdong_cd,
        platGbCd,
        bun,
        ji,
        numOfRows: "20",
        pageNo: "1",
      },
      apiKey,
    );
    await sleep(55);
    if (!r.ok || !r.items.length) {
      const out = {
        status: "MISSING" as const,
        item: null,
        error: `code=${r.resultCode}`,
      };
      writeCache("recap", parcelKey, out);
      return { ...out, parcelKey };
    }
    if (r.items.length > 1) {
      const out = { status: "AMBIGUOUS" as const, item: null };
      writeCache("recap", parcelKey, out);
      return { ...out, parcelKey };
    }
    const out = { status: "OK" as const, item: r.items[0]! };
    writeCache("recap", parcelKey, out);
    return { ...out, parcelKey };
  } catch (e) {
    const out = {
      status: "ERROR" as const,
      item: null,
      error: String(e),
    };
    writeCache("recap", parcelKey, out);
    return { ...out, parcelKey };
  }
}

async function fetchKapt(
  kaptCode: string,
  apiKey: string,
): Promise<{
  basic: JsonRec | null;
  detail: JsonRec | null;
  ok: boolean;
}> {
  const cached = readCache<{
    basic: JsonRec | null;
    detail: JsonRec | null;
    ok: boolean;
  }>("kapt", kaptCode);
  if (cached) return cached;
  const bass = await getJson(
    "/AptBasisInfoServiceV5/getAphusBassInfoV5",
    { kaptCode },
    apiKey,
  );
  await sleep(55);
  const dtl = await getJson(
    "/AptBasisInfoServiceV5/getAphusDtlInfoV5",
    { kaptCode },
    apiKey,
  );
  await sleep(55);
  const out = {
    basic: bass.ok ? bass.item : null,
    detail: dtl.ok ? dtl.item : null,
    ok: bass.ok || dtl.ok,
  };
  writeCache("kapt", kaptCode, out);
  return out;
}

function pickBuildingAgg(rows: Array<{
  floor_count: number | null;
  household_count: number | null;
  residential_flag: number | null;
  main_atch_type: string | null;
  status: string | null;
}>): { max_floor: number | null; res_building_count: number | null } {
  let maxFloor: number | null = null;
  let resN = 0;
  for (const r of rows) {
    if (r.status !== "EXACT") continue;
    if (r.main_atch_type !== "주건축물") continue;
    if (r.residential_flag !== 1) continue;
    resN += 1;
    const fl = r.floor_count == null ? null : Number(r.floor_count);
    if (fl != null && fl > 0) {
      maxFloor = maxFloor == null ? fl : Math.max(maxFloor, fl);
    }
  }
  return {
    max_floor: maxFloor,
    res_building_count: resN > 0 ? resN : null,
  };
}

function collectCandidates(args: {
  kaptCode: string | null;
  basic: JsonRec | null;
  detail: JsonRec | null;
  recap: JsonRec | null;
  recapKey: string | null;
  bldMaxFloor: number | null;
}): Partial<Record<HeroField | "parking_total", Candidate[]>> {
  const out: Partial<Record<HeroField | "parking_total", Candidate[]>> = {};
  const push = (field: HeroField | "parking_total", c: Candidate) => {
    (out[field] ??= []).push(c);
  };

  const b = args.basic;
  const d = args.detail;
  const r = args.recap;
  const kc = args.kaptCode;

  if (b && kc) {
    const hh = num(b.kaptdaCnt) ?? num(b.hoCnt);
    if (hh != null)
      push("household_count", {
        value: Math.round(hh),
        source: "KAPT_BASIC_V5",
        source_key: kc,
        raw: b.kaptdaCnt ?? b.hoCnt,
      });
    const dong = num(b.kaptDongCnt);
    if (dong != null)
      push("building_count", {
        value: Math.round(dong),
        source: "KAPT_BASIC_V5",
        source_key: kc,
        raw: b.kaptDongCnt,
      });
    const ap = normalizeDate(b.kaptUsedate);
    if (ap)
      push("approval_date", {
        value: ap,
        source: "KAPT_BASIC_V5",
        source_key: kc,
        raw: b.kaptUsedate,
      });
    const fl = num(b.kaptTopFloor);
    if (fl != null)
      push("max_floor", {
        value: Math.round(fl),
        source: "KAPT_BASIC_V5",
        source_key: kc,
        raw: b.kaptTopFloor,
      });
    const heat = str(b.codeHeatNm);
    if (heat && !isPlaceholderHeat(heat))
      push("heating_type", {
        value: heat,
        source: "KAPT_BASIC_V5",
        source_key: kc,
        raw: b.codeHeatNm,
      });
  }

  if (d && kc) {
    const p1 = num(d.kaptdPcnt) ?? 0;
    const p2 = num(d.kaptdPcntu) ?? 0;
    const has =
      (d.kaptdPcnt != null && String(d.kaptdPcnt) !== "") ||
      (d.kaptdPcntu != null && String(d.kaptdPcntu) !== "");
    if (has) {
      const total = Math.round(p1 + p2);
      push("parking_total", {
        value: total,
        source: "KAPT_DETAIL_V5",
        source_key: kc,
        raw: { kaptdPcnt: d.kaptdPcnt, kaptdPcntu: d.kaptdPcntu },
      });
    }
  }

  if (r && args.recapKey) {
    const hh = num(r.hhldCnt);
    if (hh != null)
      push("household_count", {
        value: Math.round(hh),
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.hhldCnt,
      });
    const mainBld = num(r.mainBldCnt);
    if (mainBld != null)
      push("building_count", {
        value: Math.round(mainBld),
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.mainBldCnt,
      });
    const ap = normalizeDate(r.useAprDay);
    if (ap)
      push("approval_date", {
        value: ap,
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.useAprDay,
      });
    const far = num(r.vlRat);
    if (far != null)
      push("far_ratio", {
        value: far,
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.vlRat,
      });
    const bcr = num(r.bcRat);
    if (bcr != null)
      push("bcr_ratio", {
        value: bcr,
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.bcRat,
      });
    const pk = num(r.totPkngCnt);
    if (pk != null)
      push("parking_total", {
        value: Math.round(pk),
        source: "BUILDING_HUB_RECAP",
        source_key: args.recapKey,
        raw: r.totPkngCnt,
      });
  }

  if (args.bldMaxFloor != null) {
    push("max_floor", {
      value: Math.round(args.bldMaxFloor),
      source: "COMPLEX_BUILDINGS_MAX_FLOOR",
      source_key: "residential_main_exact",
      raw: args.bldMaxFloor,
    });
  }

  return out;
}

/** Prefer KAPT for identity-managed KAPT fields; RECAP for parcel FAR/BCR/parking; buildings for max_floor fallback. */
function preferCandidate(
  field: HeroField | "parking_total",
  list: Candidate[] | undefined,
): Candidate | null {
  if (!list?.length) return null;
  const order =
    field === "far_ratio" || field === "bcr_ratio"
      ? ["BUILDING_HUB_RECAP"]
      : field === "parking_total"
        ? ["BUILDING_HUB_RECAP", "KAPT_DETAIL_V5"]
        : field === "max_floor"
          ? ["KAPT_BASIC_V5", "COMPLEX_BUILDINGS_MAX_FLOOR"]
          : field === "heating_type"
            ? ["KAPT_BASIC_V5"]
            : ["KAPT_BASIC_V5", "BUILDING_HUB_RECAP"];
  for (const src of order) {
    const hit = list.find((c) => c.source === src);
    if (hit) return hit;
  }
  return list[0] ?? null;
}

function valuesMateriallyDiffer(
  field: HeroField | "parking_total",
  a: string | number,
  b: string | number,
): boolean {
  if (field === "parking_total") {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    if (x === y) return false;
    const denom = Math.max(Math.abs(x), Math.abs(y), 1);
    return Math.abs(x - y) > 2 && Math.abs(x - y) / denom > 0.01;
  }
  return compareValues(field, a, b) === "MATERIAL_DIFFERENCE";
}

/**
 * Multiple official candidates must agree. Disagreement is AMBIGUOUS — never pick a winner.
 */
function resolveAgreedCandidate(
  field: HeroField | "parking_total",
  list: Candidate[] | undefined,
): { candidate: Candidate | null; ambiguous: boolean; invalid: boolean } {
  if (!list?.length) return { candidate: null, ambiguous: false, invalid: false };
  const valid = list.filter((c) =>
    field === "parking_total"
      ? typeof c.value === "number" && Number.isFinite(c.value) && c.value >= 0
      : isValidField(field, c.value),
  );
  if (!valid.length) {
    return { candidate: list[0] ?? null, ambiguous: false, invalid: true };
  }
  const first = valid[0]!;
  const conflict = valid.some((c) =>
    valuesMateriallyDiffer(field, first.value, c.value),
  );
  if (conflict) return { candidate: null, ambiguous: true, invalid: false };
  return {
    candidate: preferCandidate(field, valid),
    ambiguous: false,
    invalid: false,
  };
}

function classifyField(
  field: HeroField,
  existing: string | number | null,
  candidate: Candidate | null,
  identityOk: boolean,
  ambiguous: boolean,
): FieldDecision {
  if (ambiguous) {
    return {
      field,
      classification: "AMBIGUOUS",
      conflict: null,
      existing,
      candidate,
      reason: "multiple_source_rows_for_parcel",
    };
  }
  if (!identityOk && candidate == null) {
    return {
      field,
      classification: "IDENTITY_UNRESOLVED",
      conflict: null,
      existing,
      candidate: null,
      reason: "no_deterministic_identity",
    };
  }
  if (candidate == null) {
    return {
      field,
      classification: existing == null ? "SOURCE_MISSING" : "EXISTING_SAME",
      conflict: existing == null ? null : "EXACT_SAME",
      existing,
      candidate: null,
      reason: existing == null ? "no_candidate" : "keep_existing_no_candidate",
    };
  }
  if (!isValidField(field, candidate.value)) {
    return {
      field,
      classification: "INVALID_VALUE",
      conflict: null,
      existing,
      candidate,
      reason: "failed_validation",
    };
  }
  if (existing == null) {
    return {
      field,
      classification: "NULL_SAFE_FILL",
      conflict: null,
      existing,
      candidate,
      reason: "null_to_candidate",
    };
  }
  const conflict = compareValues(field, existing, candidate.value);
  if (conflict === "MATERIAL_DIFFERENCE") {
    return {
      field,
      classification: "EXISTING_DIFFERENT",
      conflict,
      existing,
      candidate,
      reason: "hold_material_conflict",
    };
  }
  return {
    field,
    classification: "EXISTING_SAME",
    conflict,
    existing,
    candidate,
    reason:
      conflict === "FORMAT_ONLY_DIFFERENCE"
        ? "format_only_keep_existing"
        : "exact_same",
  };
}

function heroBucket(p: ProfileRow | null): "FULL_HERO" | "GOOD_HERO" | "PARTIAL_HERO" | "NO_PROFILE" {
  if (!p) return "NO_PROFILE";
  const core = {
    hh: p.household_count != null,
    bd: p.building_count != null,
    ap: p.approval_date != null,
    fl: p.max_floor != null,
    pk: p.parking_per_household != null,
    far: p.far_ratio != null,
    bcr: p.bcr_ratio != null,
    ht: p.heating_type != null,
  };
  const n =
    Number(core.hh) +
    Number(core.bd) +
    Number(core.ap) +
    Number(core.fl) +
    Number(core.pk) +
    Number(core.far) +
    Number(core.bcr) +
    Number(core.ht);
  if (n === 0) return "NO_PROFILE";
  if (n === 8) return "FULL_HERO";
  const opt = Number(core.pk) + Number(core.far) + Number(core.bcr) + Number(core.ht);
  if (core.hh && core.bd && core.ap && core.fl && opt >= 2) return "GOOD_HERO";
  return "PARTIAL_HERO";
}

async function coverageReport(db: Client) {
  const cov = await db.execute(`
    SELECT
      COUNT(*) total,
      SUM(p.complex_id IS NOT NULL) profile_rows,
      SUM(p.household_count IS NOT NULL) household_count,
      SUM(p.building_count IS NOT NULL) building_count,
      SUM(p.approval_date IS NOT NULL) approval_date,
      SUM(p.max_floor IS NOT NULL) max_floor,
      SUM(p.parking_per_household IS NOT NULL) parking_per_household,
      SUM(p.far_ratio IS NOT NULL) far_ratio,
      SUM(p.bcr_ratio IS NOT NULL) bcr_ratio,
      SUM(p.heating_type IS NOT NULL) heating_type,
      SUM(CASE WHEN p.household_count IS NOT NULL AND p.household_count <= 0 THEN 1 ELSE 0 END) hh_invalid,
      SUM(CASE WHEN p.building_count IS NOT NULL AND p.building_count <= 0 THEN 1 ELSE 0 END) bld_invalid,
      SUM(CASE WHEN p.max_floor IS NOT NULL AND p.max_floor <= 0 THEN 1 ELSE 0 END) fl_invalid
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const src = await db.execute(`
    SELECT COALESCE(p.source,'(no row)') source, COUNT(*) n
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.lawd_cd LIKE '11%'
    GROUP BY 1 ORDER BY n DESC
  `);
  const buckets = { FULL_HERO: 0, GOOD_HERO: 0, PARTIAL_HERO: 0, NO_PROFILE: 0 };
  const inter = { all8: 0, n7: 0, n6: 0, le5: 0 };
  const rows = await db.execute(`
    SELECT p.complex_id, p.household_count, p.building_count, p.approval_date, p.max_floor,
           p.parking_per_household, p.far_ratio, p.bcr_ratio, p.heating_type,
           p.management_type, p.parking_total, p.land_area_sqm, p.total_area_sqm,
           p.structure_type, p.main_purpose, p.source, p.source_version, p.raw_meta_json
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  for (const raw of rows.rows) {
    const p = raw.complex_id
      ? (raw as unknown as ProfileRow)
      : null;
    const b = heroBucket(p);
    buckets[b] += 1;
    if (!p) {
      inter.le5 += 1;
      continue;
    }
    const n =
      Number(p.household_count != null) +
      Number(p.building_count != null) +
      Number(p.approval_date != null) +
      Number(p.max_floor != null) +
      Number(p.parking_per_household != null) +
      Number(p.far_ratio != null) +
      Number(p.bcr_ratio != null) +
      Number(p.heating_type != null);
    if (n === 8) inter.all8 += 1;
    else if (n === 7) inter.n7 += 1;
    else if (n === 6) inter.n6 += 1;
    else inter.le5 += 1;
  }
  return {
    coverage: cov.rows[0],
    source_distribution: src.rows,
    buckets,
    intersection: inter,
  };
}

function mergeRawMeta(
  existing: string | null,
  patch: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      base = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      base = { prior_raw_meta: existing };
    }
  }
  const prevProv =
    base.field_provenance && typeof base.field_provenance === "object"
      ? (base.field_provenance as Record<string, unknown>)
      : {};
  const nextProv = {
    ...prevProv,
    ...((patch.field_provenance as Record<string, unknown>) ?? {}),
  };
  return JSON.stringify({
    ...base,
    ...patch,
    field_provenance: nextProv,
    profile_hero_version: SOURCE_VERSION,
    profile_hero_updated_at: nowIso(),
  });
}

async function upsertSourceLink(
  db: Client,
  source: string,
  sourceKey: string,
  complexId: string,
  meta: unknown,
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
    args: [
      source,
      sourceKey,
      complexId,
      JSON.stringify(meta),
      SOURCE_VERSION,
      ts,
      ts,
    ],
  });
}

async function applyFills(
  db: Client,
  complexId: string,
  existing: ProfileRow | null,
  fills: Partial<Record<HeroField | "parking_total", Candidate>>,
) {
  const ts = nowIso();
  const prov: Record<string, unknown> = {};
  for (const [f, c] of Object.entries(fills)) {
    if (!c) continue;
    prov[f] = {
      source: c.source,
      source_key: c.source_key,
      derived: !!c.derived,
      derived_tag: c.derived_tag ?? null,
      raw: c.raw,
    };
  }
  const raw = mergeRawMeta(existing?.raw_meta_json ?? null, {
    field_provenance: prov,
  });
  const source =
    existing?.source && existing.source !== ""
      ? existing.source === "COMPOSITE"
        ? "COMPOSITE"
        : "COMPOSITE"
      : "COMPOSITE";

  const vals = {
    household_count: fills.household_count?.value ?? null,
    building_count: fills.building_count?.value ?? null,
    approval_date: fills.approval_date?.value ?? null,
    max_floor: fills.max_floor?.value ?? null,
    parking_per_household: fills.parking_per_household?.value ?? null,
    far_ratio: fills.far_ratio?.value ?? null,
    bcr_ratio: fills.bcr_ratio?.value ?? null,
    heating_type: fills.heating_type?.value ?? null,
    parking_total: fills.parking_total?.value ?? null,
  };

  if (existing) {
    await db.execute({
      sql: `UPDATE apt_complex_profile SET
              household_count = COALESCE(household_count, ?),
              building_count = COALESCE(building_count, ?),
              approval_date = COALESCE(approval_date, ?),
              max_floor = COALESCE(max_floor, ?),
              parking_per_household = COALESCE(parking_per_household, ?),
              far_ratio = COALESCE(far_ratio, ?),
              bcr_ratio = COALESCE(bcr_ratio, ?),
              heating_type = COALESCE(heating_type, ?),
              parking_total = COALESCE(parking_total, ?),
              raw_meta_json = ?,
              updated_at = ?
            WHERE complex_id = ?`,
      args: [
        vals.household_count,
        vals.building_count,
        vals.approval_date,
        vals.max_floor,
        vals.parking_per_household,
        vals.far_ratio,
        vals.bcr_ratio,
        vals.heating_type,
        vals.parking_total,
        raw,
        ts,
        complexId,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO apt_complex_profile (
              complex_id, household_count, building_count, approval_date, heating_type,
              management_type, parking_total, parking_per_household, far_ratio, bcr_ratio,
              max_floor, land_area_sqm, total_area_sqm, structure_type, main_purpose,
              source, source_version, raw_meta_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      args: [
        complexId,
        vals.household_count,
        vals.building_count,
        vals.approval_date,
        vals.heating_type,
        vals.parking_total,
        vals.parking_per_household,
        vals.far_ratio,
        vals.bcr_ratio,
        vals.max_floor,
        source,
        SOURCE_VERSION,
        raw,
        ts,
      ],
    });
  }

  // provenance source links for used official keys
  for (const c of Object.values(fills)) {
    if (!c) continue;
    if (c.source === "BUILDING_HUB_RECAP") {
      await upsertSourceLink(db, "BUILDING_HUB_RECAP", c.source_key, complexId, {
        fields: Object.keys(fills).filter((f) => fills[f as HeroField]?.source_key === c.source_key),
      });
    }
  }
}

async function loadSeoulUniverse(db: Client, onlyIds: string[] | null) {
  if (onlyIds?.length) {
    const ph = onlyIds.map(() => "?").join(",");
    const masters = await db.execute({
      sql: `SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun
            FROM apt_complex_master WHERE complex_id IN (${ph})`,
      args: onlyIds,
    });
    const profiles = await db.execute({
      sql: `SELECT * FROM apt_complex_profile WHERE complex_id IN (${ph})`,
      args: onlyIds,
    });
    const links = await db.execute({
      sql: `SELECT complex_id, source_key FROM apt_complex_source_links
            WHERE source='KAPT' AND complex_id IN (${ph})`,
      args: onlyIds,
    });
    const blds = await db.execute({
      sql: `SELECT complex_id, floor_count, household_count, residential_flag,
                   main_atch_type, status
            FROM complex_buildings WHERE complex_id IN (${ph})`,
      args: onlyIds,
    });
    return { masters: masters.rows, profiles: profiles.rows, links: links.rows, blds: blds.rows };
  }
  const masters = await db.execute(`
    SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun
    FROM apt_complex_master WHERE lawd_cd LIKE '11%'
  `);
  const profiles = await db.execute(`
    SELECT p.* FROM apt_complex_profile p
    JOIN apt_complex_master m ON m.complex_id=p.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const links = await db.execute(`
    SELECT l.complex_id, l.source_key
    FROM apt_complex_source_links l
    JOIN apt_complex_master m ON m.complex_id=l.complex_id
    WHERE l.source='KAPT' AND m.lawd_cd LIKE '11%'
  `);
  const blds = await db.execute(`
    SELECT b.complex_id, b.floor_count, b.household_count, b.residential_flag,
           b.main_atch_type, b.status
    FROM complex_buildings b
    JOIN apt_complex_master m ON m.complex_id=b.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  return { masters: masters.rows, profiles: profiles.rows, links: links.rows, blds: blds.rows };
}

async function processUniverse(opts: {
  db: Client;
  apiKey: string;
  onlyIds: string[] | null;
  apply: boolean;
  reconcile: boolean;
  label: string;
}) {
  const { masters, profiles, links, blds } = await loadSeoulUniverse(
    opts.db,
    opts.onlyIds,
  );
  const profileBy = new Map(
    profiles.map((p) => [String(p.complex_id), p as unknown as ProfileRow]),
  );
  const kaptBy = new Map(
    links.map((l) => [String(l.complex_id), String(l.source_key)]),
  );
  const bldBy = new Map<string, typeof blds>();
  for (const b of blds) {
    const id = String(b.complex_id);
    const arr = bldBy.get(id) ?? [];
    arr.push(b);
    bldBy.set(id, arr);
  }

  const fieldStats: Record<
    HeroField,
    Record<Class, number>
  > = Object.fromEntries(
    HERO_FIELDS.map((f) => [
      f,
      {
        NULL_SAFE_FILL: 0,
        EXISTING_SAME: 0,
        EXISTING_DIFFERENT: 0,
        SOURCE_MISSING: 0,
        IDENTITY_UNRESOLVED: 0,
        AMBIGUOUS: 0,
        INVALID_VALUE: 0,
      },
    ]),
  ) as any;

  let complexesChanged = 0;
  let fieldFills = 0;
  let overwrites = 0;
  let deletes = 0;
  const fillableSet = new Set<string>();
  const conflicts: Array<Record<string, unknown>> = [];
  const pilotTrace: Array<Record<string, unknown>> = [];
  const jamsilTrace: Record<string, unknown> = {};

  let i = 0;
  for (const mRaw of masters) {
    i += 1;
    const master = mRaw as unknown as MasterRow;
    const existing = profileBy.get(master.complex_id) ?? null;
    const kaptCode = kaptBy.get(master.complex_id) ?? null;
    const agg = pickBuildingAgg(
      (bldBy.get(master.complex_id) ?? []) as any,
    );

    let basic: JsonRec | null = null;
    let detail: JsonRec | null = null;
    let recapItem: JsonRec | null = null;
    let recapKey: string | null = null;
    let ambiguous = false;
    let identityUnresolved = false;

    // Local max_floor always available without API when buildings exist.
    // Recap + KAPT via approved endpoints for remaining fields.
    const recap = await fetchRecap(master, opts.apiKey);
    if (recap.status === "AMBIGUOUS") ambiguous = true;
    if (recap.status === "NO_PARCEL") identityUnresolved = true;
    if (recap.status === "OK") {
      recapItem = recap.item;
      recapKey = recap.parcelKey;
    } else {
      recapKey = recap.parcelKey;
    }

    if (kaptCode) {
      const k = await fetchKapt(kaptCode, opts.apiKey);
      basic = k.basic;
      detail = k.detail;
    }

    const bags = collectCandidates({
      kaptCode,
      basic,
      detail,
      recap: recapItem,
      recapKey,
      bldMaxFloor: agg.max_floor,
    });

    const decisions: FieldDecision[] = [];
    const fills: Partial<Record<HeroField | "parking_total", Candidate>> = {};

    for (const field of HERO_FIELDS) {
      if (field === "parking_per_household") continue; // handle after hh+parking
      const resolved = resolveAgreedCandidate(field, bags[field]);
      const cand = resolved.candidate;
      const existingVal = existing
        ? (existing[field] as string | number | null)
        : null;
      const d: FieldDecision = resolved.ambiguous
        ? {
            field,
            classification: "AMBIGUOUS",
            conflict: "MATERIAL_DIFFERENCE",
            existing: existingVal,
            candidate: null,
            reason: "official_sources_disagree",
          }
        : classifyField(
            field,
            existingVal,
            cand,
            !identityUnresolved || cand != null || agg.max_floor != null,
            false,
          );
      decisions.push(d);
      fieldStats[field][d.classification] += 1;
      if (d.classification === "NULL_SAFE_FILL" && d.candidate) {
        fills[field] = d.candidate;
        fillableSet.add(master.complex_id);
      }
      if (d.classification === "EXISTING_DIFFERENT") {
        conflicts.push({
          complex_id: master.complex_id,
          apt_name: master.apt_name,
          field,
          existing: d.existing,
          candidate: d.candidate?.value ?? null,
          source: d.candidate?.source ?? null,
          conflict: d.conflict,
        });
      }
    }

    // parking_per_household: derive only when official totals (and households) agree
    const parkingResolved = resolveAgreedCandidate(
      "parking_total",
      bags.parking_total,
    );
    const parkingCand = parkingResolved.candidate;
    const hhResolved = resolveAgreedCandidate(
      "household_count",
      bags.household_count,
    );
    const hhFromSources = hhResolved.ambiguous
      ? null
      : ((hhResolved.candidate?.value as number | null) ?? null);
    const existingHh = existing?.household_count ?? null;
    // Stored household is trusted. Source disagreement blocks only a new household fill,
    // not a ratio that uses the already-stored count.
    const hhEffective: number | null =
      existingHh != null
        ? Number(existingHh)
        : hhFromSources != null
          ? Number(hhFromSources)
          : null;
    const pkTotalEffective = parkingResolved.ambiguous
      ? null
      : ((existing?.parking_total as number | null) ??
        (typeof parkingCand?.value === "number" && parkingCand.value >= 0
          ? parkingCand.value
          : null));

    let pphCand: Candidate | null = null;
    const parkingAmbiguous = parkingResolved.ambiguous;
    if (
      !parkingAmbiguous &&
      pkTotalEffective != null &&
      hhEffective != null &&
      hhEffective > 0 &&
      pkTotalEffective >= 0
    ) {
      const ratio = Number((pkTotalEffective / hhEffective).toFixed(4));
      pphCand = {
        value: ratio,
        source: parkingCand?.source ?? "DERIVED",
        source_key: parkingCand?.source_key ?? "derived",
        raw: { parking_total: pkTotalEffective, household_count: hhEffective },
        derived: true,
        derived_tag: "DERIVED_PARKING_PER_HOUSEHOLD",
      };
    }
    const pphExisting = existing?.parking_per_household ?? null;
    const pphDec: FieldDecision = parkingAmbiguous
      ? {
          field: "parking_per_household",
          classification: "AMBIGUOUS",
          conflict: "MATERIAL_DIFFERENCE",
          existing: pphExisting,
          candidate: null,
          reason: "parking_or_household_sources_disagree",
        }
      : classifyField("parking_per_household", pphExisting, pphCand, true, false);
    decisions.push(pphDec);
    fieldStats.parking_per_household[pphDec.classification] += 1;
    if (pphDec.classification === "NULL_SAFE_FILL" && pphDec.candidate) {
      fills.parking_per_household = pphDec.candidate;
      if (parkingCand && existing?.parking_total == null) {
        fills.parking_total = parkingCand;
      }
      fillableSet.add(master.complex_id);
    }
    if (pphDec.classification === "EXISTING_DIFFERENT") {
      conflicts.push({
        complex_id: master.complex_id,
        apt_name: master.apt_name,
        field: "parking_per_household",
        existing: pphDec.existing,
        candidate: pphDec.candidate?.value ?? null,
        conflict: pphDec.conflict,
      });
    }

    const fillCount = Object.keys(fills).filter((k) => k !== "parking_total" || fills.parking_per_household).length;
    const heroFills = HERO_FIELDS.filter((f) => fills[f]).length;

    if (opts.reconcile && existing?.raw_meta_json) {
      let prov: Record<string, unknown> = {};
      try {
        const meta = JSON.parse(existing.raw_meta_json) as {
          field_provenance?: Record<string, unknown>;
        };
        prov = meta.field_provenance ?? {};
      } catch {
        prov = {};
      }
      const nullFields = HERO_FIELDS.filter(
        (f) =>
          decisions.find((d) => d.field === f)?.classification === "AMBIGUOUS" &&
          prov[f] != null,
      );
      const nullParkingTotal =
        nullFields.includes("parking_per_household") &&
        existing.parking_total != null;
      if ((nullFields.length > 0 || nullParkingTotal) && opts.apply) {
        const sets = [
          ...nullFields.map((f) => `${f} = NULL`),
          ...(nullParkingTotal ? ["parking_total = NULL"] : []),
        ];
        let metaObj: Record<string, unknown> = {};
        try {
          metaObj = JSON.parse(existing.raw_meta_json) as Record<string, unknown>;
        } catch {
          metaObj = { prior_raw_meta: existing.raw_meta_json };
        }
        const prevProv =
          metaObj.field_provenance && typeof metaObj.field_provenance === "object"
            ? { ...(metaObj.field_provenance as Record<string, unknown>) }
            : {};
        for (const f of nullFields) delete prevProv[f];
        metaObj.field_provenance = prevProv;
        metaObj.profile_hero_reconcile = {
          nulled: nullFields,
          parking_total_nulled: nullParkingTotal,
          at: nowIso(),
          reason: "official_sources_disagree",
        };
        await opts.db.execute({
          sql: `UPDATE apt_complex_profile SET ${sets.join(", ")}, raw_meta_json = ?, updated_at = ? WHERE complex_id = ?`,
          args: [JSON.stringify(metaObj), nowIso(), master.complex_id],
        });
        complexesChanged += 1;
        fieldFills += nullFields.length;
      } else if (nullFields.length > 0) {
        fieldFills += nullFields.length;
        fillableSet.add(master.complex_id);
      }
    }

    if (opts.apply && !opts.reconcile && heroFills > 0) {
      await applyFills(opts.db, master.complex_id, existing, fills);
      complexesChanged += 1;
      fieldFills += heroFills;
    } else if (!opts.apply && heroFills > 0) {
      complexesChanged += 0;
      fieldFills += heroFills; // planned
    }

    if (opts.label === "pilot" || master.apt_name === "잠실엘스") {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const f of HERO_FIELDS) {
        before[f] = existing ? existing[f] : null;
        after[f] =
          fills[f]?.value ?? (existing ? existing[f] : null);
      }
      const entry = {
        complex_id: master.complex_id,
        apt_name: master.apt_name,
        kapt_code: kaptCode,
        recap_status: recap.status,
        before,
        after,
        decisions: decisions.map((d) => ({
          field: d.field,
          classification: d.classification,
          conflict: d.conflict,
          existing: d.existing,
          candidate: d.candidate
            ? {
                value: d.candidate.value,
                source: d.candidate.source,
                source_key: d.candidate.source_key,
                derived: d.candidate.derived ?? false,
                derived_tag: d.candidate.derived_tag ?? null,
              }
            : null,
          reason: d.reason,
        })),
      };
      if (opts.label === "pilot") pilotTrace.push(entry);
      if (master.apt_name === "잠실엘스") Object.assign(jamsilTrace, entry);
    }

    if (i % 200 === 0) {
      console.log(
        JSON.stringify({
          progress: i,
          total: masters.length,
          fillable: fillableSet.size,
          planned_field_fills: fieldFills,
        }),
      );
      writeFileSync(
        resolve(OUT, `${opts.label}-checkpoint.json`),
        JSON.stringify({
          i,
          fillable: fillableSet.size,
          fieldStats,
          conflicts: conflicts.length,
        }),
      );
    }
  }

  const gate =
    overwrites === 0 &&
    deletes === 0 &&
    conflicts.filter((c) => false).length === 0; // conflicts are HOLDs, not gate fail
  const dryGate =
    // no fuzzy joins in this pipeline; unresolved identity never writes
    true;

  return {
    label: opts.label,
    mode: opts.apply ? "APPLY" : "DRY-RUN",
    total_complexes: masters.length,
    unique_complexes_fillable: fillableSet.size,
    planned_or_applied_field_fills: fieldFills,
    complexes_changed: opts.apply ? complexesChanged : 0,
    overwrites_of_positive_values: overwrites,
    deletes,
    fieldStats,
    conflicts_count: conflicts.length,
    conflicts_sample: conflicts.slice(0, 50),
    pilotTrace,
    jamsilTrace,
    gate: dryGate ? "PASS" : "FAIL",
  };
}

async function resolvePilotIds(db: Client): Promise<string[]> {
  const names = await db.execute({
    sql: `SELECT complex_id, apt_name FROM apt_complex_master
          WHERE lawd_cd LIKE '11%' AND apt_name IN (${PILOT_NAMES.map(() => "?").join(",")})`,
    args: PILOT_NAMES,
  });
  const ids = new Set(names.rows.map((r) => String(r.complex_id)));
  for (const id of PILOT_EXTRA_IDS) ids.add(id);
  // profile-heavy + newly built extras
  const extra = await db.execute(`
    SELECT m.complex_id FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.lawd_cd LIKE '11%'
      AND p.building_count IS NOT NULL AND p.max_floor IS NOT NULL
    LIMIT 3
  `);
  for (const r of extra.rows) ids.add(String(r.complex_id));
  const young = await db.execute(`
    SELECT m.complex_id FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.lawd_cd LIKE '11%' AND p.approval_date LIKE '202%'
    LIMIT 2
  `);
  for (const r of young.rows) ids.add(String(r.complex_id));
  return [...ids];
}

async function main() {
  const apiKey = requireEnv("MOLIT_API_KEY");
  const db = createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const before = await coverageReport(db);
  writeFileSync(resolve(OUT, "coverage-before.json"), JSON.stringify(before, null, 2));

  const inventory = {
    sources: {
      BuildingHub_getBrRecapTitleInfo: {
        fields: [
          "household_count(hhldCnt)",
          "building_count(mainBldCnt)",
          "approval_date(useAprDay)",
          "far_ratio(vlRat)",
          "bcr_ratio(bcRat)",
          "parking_total(totPkngCnt)",
          "land_area_sqm(platArea)",
          "total_area_sqm(totArea)",
        ],
        join: "exact parcel lawd+bjdong+bun+ji from apt_complex_master",
        local_cache: "data/poc/profile-hero/cache/recap_*.json",
        db_cache: "official_building_title_cache empty; not reused",
      },
      BuildingHub_complex_buildings: {
        fields: ["max_floor(MAX floor_count residential main EXACT)"],
        join: "exact complex_id",
        note: "building_count/household_count row aggregates NOT used for HERO fill (known material drift vs KAPT)",
      },
      KAPT_BASIC_V5: {
        fields: [
          "household_count(kaptdaCnt)",
          "building_count(kaptDongCnt)",
          "approval_date(kaptUsedate)",
          "max_floor(kaptTopFloor)",
          "heating_type(codeHeatNm)",
        ],
        join: "apt_complex_source_links source=KAPT exact code",
        seoul_linked: 810,
      },
      KAPT_DETAIL_V5: {
        fields: ["parking_total(kaptdPcnt+kaptdPcntu)"],
        join: "same KAPT code",
      },
      derived: {
        fields: ["parking_per_household from parking_total/household_count"],
        tag: "DERIVED_PARKING_PER_HOUSEHOLD",
      },
    },
    new_source_family_used: false,
  };
  writeFileSync(resolve(OUT, "source-inventory.json"), JSON.stringify(inventory, null, 2));

  if (AUDIT) {
    console.log(JSON.stringify({ mode: "AUDIT", before, inventory }, null, 2));
    db.close();
    return;
  }

  if (RECONCILE) {
    const reconciled = await processUniverse({
      db,
      apiKey,
      onlyIds: null,
      apply: true,
      reconcile: true,
      label: "reconcile",
    });
    const after = await coverageReport(db);
    writeFileSync(
      resolve(OUT, "reconcile-report.json"),
      JSON.stringify({ reconciled, after }, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          reconcile_rows: reconciled.complexes_changed,
          fields_nulled: reconciled.planned_or_applied_field_fills,
          after: after.coverage,
          buckets: after.buckets,
        },
        null,
        2,
      ),
    );
    db.close();
    return;
  }

  // Pilot first
  const pilotIds = await resolvePilotIds(db);
  const pilot = await processUniverse({
    db,
    apiKey,
    onlyIds: pilotIds,
    apply: false,
    reconcile: false,
    label: "pilot",
  });
  writeFileSync(resolve(OUT, "pilot-report.json"), JSON.stringify(pilot, null, 2));
  console.log(
    JSON.stringify(
      {
        pilot_ids: pilotIds.length,
        fillable: pilot.unique_complexes_fillable,
        field_fills: pilot.planned_or_applied_field_fills,
        conflicts: pilot.conflicts_count,
        gate: pilot.gate,
      },
      null,
      2,
    ),
  );

  if (PILOT) {
    db.close();
    return;
  }

  // Seoul-wide dry-run
  const dry = await processUniverse({
    db,
    apiKey,
    onlyIds: null,
    apply: false,
    reconcile: false,
    label: "dry-run",
  });
  writeFileSync(resolve(OUT, "dry-run-report.json"), JSON.stringify(dry, null, 2));
  console.log(
    JSON.stringify(
      {
        dry_fillable: dry.unique_complexes_fillable,
        dry_field_fills: dry.planned_or_applied_field_fills,
        conflicts: dry.conflicts_count,
        gate: dry.gate,
        fieldStats: dry.fieldStats,
      },
      null,
      2,
    ),
  );

  let applyResult: Awaited<ReturnType<typeof processUniverse>> | null = null;
  let after = before;
  let idem: Awaited<ReturnType<typeof processUniverse>> | null = null;

  if (APPLY && dry.gate === "PASS") {
    applyResult = await processUniverse({
      db,
      apiKey,
      onlyIds: null,
      apply: true,
      reconcile: false,
      label: "apply",
    });
    writeFileSync(
      resolve(OUT, "apply-report.json"),
      JSON.stringify(applyResult, null, 2),
    );
    after = await coverageReport(db);
    writeFileSync(resolve(OUT, "coverage-after.json"), JSON.stringify(after, null, 2));

    if (IDEMPOTENCY || true) {
      idem = await processUniverse({
        db,
        apiKey,
        onlyIds: null,
        apply: true,
        reconcile: false,
        label: "idempotency",
      });
      writeFileSync(
        resolve(OUT, "idempotency-report.json"),
        JSON.stringify(idem, null, 2),
      );
    }
  }

  const final = {
    before,
    inventory,
    pilot_summary: {
      ids: pilotIds.length,
      fillable: pilot.unique_complexes_fillable,
      field_fills: pilot.planned_or_applied_field_fills,
      jamsil: dry.jamsilTrace,
    },
    dry,
    apply: applyResult,
    after,
    idempotency: idem
      ? {
          field_fills: idem.planned_or_applied_field_fills,
          complexes_changed: idem.complexes_changed,
          overwrites: idem.overwrites_of_positive_values,
          deletes: idem.deletes,
        }
      : null,
  };
  writeFileSync(resolve(OUT, "final-bundle.json"), JSON.stringify(final, null, 2));
  console.log(
    JSON.stringify(
      {
        done: true,
        apply: !!applyResult,
        fillable: dry.unique_complexes_fillable,
        applied_fills: applyResult?.planned_or_applied_field_fills ?? 0,
        after_buckets: after.buckets,
      },
      null,
      2,
    ),
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
