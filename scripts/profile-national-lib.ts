/**
 * PROFILE national closeout — shared helpers (validation, sources, apply).
 * Missing-only / NULL_SAFE_FILL. No FAR/BCR from KAPT. No building-row count/household sum.
 */
import { createClient, type Client } from "@libsql/client";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const OUT = resolve(ROOT, "data/poc/profile-national");
export const CACHE = resolve(OUT, "cache");
export const SOURCE_VERSION = "profile-national-v1";
export const BASE = "https://apis.data.go.kr/1613000";

export const HERO_FIELDS = [
  "household_count",
  "building_count",
  "approval_date",
  "max_floor",
  "parking_per_household",
  "far_ratio",
  "bcr_ratio",
  "heating_type",
] as const;
export type HeroField = (typeof HERO_FIELDS)[number];

export type TargetStatus =
  | "READY_LOCAL"
  | "READY_API"
  | "COMPLETE"
  | "CONFLICT"
  | "AMBIGUOUS"
  | "NO_SOURCE"
  | "FAILED_RETRYABLE";

export type RegionKey =
  | "SEOUL"
  | "GYEONGGI"
  | "INCHEON"
  | "BUSAN"
  | "DAEGU"
  | "DAEJEON"
  | "ULSAN"
  | "SEJONG"
  | "GANGWON"
  | "CHUNGBUK"
  | "CHUNGNAM"
  | "JEONBUK"
  | "GYEONGBUK"
  | "GYEONGNAM"
  | "JEJU"
  | "GWANGJU_JEONNAM"
  | "OTHER";

/** Priority: lower runs first. P3 last for synthetic 전남광주(12). */
export const REGION_PRIORITY: Record<string, { key: RegionKey; priority: number }> = {
  "41": { key: "GYEONGGI", priority: 0 },
  "11": { key: "SEOUL", priority: 1 },
  "28": { key: "INCHEON", priority: 2 },
  "26": { key: "BUSAN", priority: 2 },
  "27": { key: "DAEGU", priority: 3 },
  "30": { key: "DAEJEON", priority: 3 },
  "31": { key: "ULSAN", priority: 3 },
  "36": { key: "SEJONG", priority: 3 },
  "51": { key: "GANGWON", priority: 3 },
  "43": { key: "CHUNGBUK", priority: 3 },
  "44": { key: "CHUNGNAM", priority: 3 },
  "52": { key: "JEONBUK", priority: 3 },
  "47": { key: "GYEONGBUK", priority: 3 },
  "48": { key: "GYEONGNAM", priority: 3 },
  "50": { key: "JEJU", priority: 3 },
  "12": { key: "GWANGJU_JEONNAM", priority: 4 },
};

export type JsonRec = Record<string, unknown>;

export type Candidate = {
  value: string | number;
  source: string;
  source_key: string;
  raw: unknown;
  derived?: boolean;
  derived_tag?: string;
};

export type ProfileSnap = {
  complex_id: string;
  household_count: number | null;
  building_count: number | null;
  approval_date: string | null;
  heating_type: string | null;
  parking_total: number | null;
  parking_per_household: number | null;
  far_ratio: number | null;
  bcr_ratio: number | null;
  max_floor: number | null;
  source: string | null;
  source_version: string | null;
  raw_meta_json: string | null;
};

export type MasterSnap = {
  complex_id: string;
  apt_name: string;
  sido: string | null;
  sigungu: string | null;
  lawd_cd: string;
  bjdong_cd: string | null;
  jibun: string | null;
};

export function nowIso() {
  return new Date().toISOString();
}

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function regionOf(lawd: string): { key: RegionKey; priority: number } {
  const p = lawd.slice(0, 2);
  return REGION_PRIORITY[p] ?? { key: "OTHER", priority: 9 };
}

export function padBunJi(jibun: string) {
  const raw = jibun.replace(/^산\s*/, "").trim();
  const [a, b] = raw.split("-");
  return {
    bun: String(Number(a || 0)).padStart(4, "0"),
    ji: String(Number(b || 0)).padStart(4, "0"),
    platGbCd: jibun.trim().startsWith("산") ? "1" : "0",
  };
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function normalizeDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

export function isPlaceholderHeat(s: string | null): boolean {
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

export function isValidField(
  field: HeroField | "parking_total",
  value: string | number | null,
): boolean {
  if (value == null) return false;
  if (field === "heating_type") {
    return typeof value === "string" && !isPlaceholderHeat(value);
  }
  if (field === "approval_date") {
    const d = normalizeDate(value);
    if (!d) return false;
    const y = Number(d.slice(0, 4));
    if (y < 1950 || y > 2100) return false;
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
  if (field === "parking_total") return n >= 0;
  if (field === "parking_per_household") return n >= 0;
  if (field === "far_ratio") return n > 0 && n <= 2000;
  if (field === "bcr_ratio") return n > 0 && n <= 100;
  return true;
}

export function nearlyEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export type ConflictKind =
  | "EXACT_SAME"
  | "FORMAT_ONLY_DIFFERENCE"
  | "MATERIAL_DIFFERENCE"
  | null;

export function compareValues(
  field: HeroField | "parking_total",
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
  if (
    (field === "parking_per_household" ||
      field === "parking_total" ||
      field === "far_ratio" ||
      field === "bcr_ratio") &&
    nearlyEqual(e, c, 0.05)
  ) {
    return "FORMAT_ONLY_DIFFERENCE";
  }
  if (field === "parking_total") {
    const denom = Math.max(Math.abs(e), Math.abs(c), 1);
    if (Math.abs(e - c) > 2 && Math.abs(e - c) / denom > 0.01) {
      return "MATERIAL_DIFFERENCE";
    }
    return "FORMAT_ONLY_DIFFERENCE";
  }
  return "MATERIAL_DIFFERENCE";
}

export function valuesMateriallyDiffer(
  field: HeroField | "parking_total",
  a: string | number,
  b: string | number,
): boolean {
  return compareValues(field, a, b) === "MATERIAL_DIFFERENCE";
}

export function preferCandidate(
  field: HeroField | "parking_total",
  list: Candidate[],
): Candidate | null {
  if (!list.length) return null;
  const order =
    field === "far_ratio" || field === "bcr_ratio"
      ? ["BUILDING_HUB_RECAP", "BUILDING_HUB_DUPLICATE_COLLAPSE"]
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

export function resolveAgreedCandidate(
  field: HeroField | "parking_total",
  list: Candidate[] | undefined,
): { candidate: Candidate | null; ambiguous: boolean; invalid: boolean } {
  if (!list?.length) return { candidate: null, ambiguous: false, invalid: false };
  const valid = list.filter((c) => isValidField(field, c.value));
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

export function heroBucket(
  p: Partial<ProfileSnap> | null,
): "FULL_HERO" | "GOOD_HERO" | "PARTIAL_HERO" | "NO_PROFILE" {
  if (!p) return "NO_PROFILE";
  const core = [
    p.household_count,
    p.building_count,
    p.approval_date,
    p.max_floor,
  ];
  const opt = [
    p.parking_per_household,
    p.far_ratio,
    p.bcr_ratio,
    p.heating_type,
  ];
  const any = [...core, ...opt].some((v) => v != null && v !== "");
  if (!any) return "NO_PROFILE";
  const coreOk = core.every((v) => v != null && v !== "");
  const optN = opt.filter((v) => v != null && v !== "").length;
  if (coreOk && optN === 4) return "FULL_HERO";
  if (coreOk && optN >= 2) return "GOOD_HERO";
  return "PARTIAL_HERO";
}

/** Core chip count: household, building, approval (HERO line). */
export function coreChipCount(p: Partial<ProfileSnap> | null): number {
  if (!p) return 0;
  let n = 0;
  if (p.household_count != null) n++;
  if (p.building_count != null) n++;
  if (p.approval_date != null) n++;
  return n;
}

export function missingFields(p: ProfileSnap | null): HeroField[] {
  const miss: HeroField[] = [];
  for (const f of HERO_FIELDS) {
    const v = p ? (p as Record<string, unknown>)[f] : null;
    if (v == null || v === "") miss.push(f);
  }
  return miss;
}

export function ensureOut() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
}

export function cachePath(kind: string, key: string) {
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return resolve(CACHE, `${kind}_${safe}.json`);
}

export function readCache<T>(kind: string, key: string): T | null {
  const p = cachePath(kind, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeCache(kind: string, key: string, data: unknown) {
  writeFileSync(cachePath(kind, key), JSON.stringify(data));
}

export function openDb(): Client {
  return createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
  });
}

export type ApiStats = {
  calls: number;
  http429: number;
  http5xx: number;
  timeout: number;
  sleepMs: number;
};

export async function getJson(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  stats: ApiStats,
): Promise<{ ok: boolean; resultCode: string; items: JsonRec[]; item: JsonRec | null }> {
  const qs = new URLSearchParams({
    serviceKey: apiKey,
    _type: "json",
    ...params,
  });
  const url = `${BASE}${path}?${qs.toString()}`;
  stats.calls += 1;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  } catch (e) {
    stats.timeout += 1;
    stats.sleepMs = Math.min(5000, Math.max(200, stats.sleepMs * 1.5));
    throw e;
  }
  if (res.status === 429) {
    stats.http429 += 1;
    stats.sleepMs = Math.min(5000, Math.max(200, stats.sleepMs * 2));
  } else if (res.status >= 500) {
    stats.http5xx += 1;
    stats.sleepMs = Math.min(5000, Math.max(200, stats.sleepMs * 1.5));
  } else if (stats.sleepMs > 80) {
    stats.sleepMs = Math.max(80, Math.floor(stats.sleepMs * 0.9));
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, resultCode: `http_${res.status}`, items: [], item: null };
  }
  const resp = (body as { response?: { header?: { resultCode?: string }; body?: unknown } })
    ?.response;
  const code = String(resp?.header?.resultCode ?? res.status);
  const b = resp?.body as
    | { items?: { item?: JsonRec | JsonRec[] } | string; totalCount?: number }
    | undefined;
  let items: JsonRec[] = [];
  if (b?.items && typeof b.items === "object" && "item" in b.items) {
    const it = b.items.item;
    items = Array.isArray(it) ? it : it ? [it] : [];
  }
  return {
    ok: code === "00" || code === "0",
    resultCode: code,
    items,
    item: items[0] ?? null,
  };
}

export async function fetchRecap(
  master: MasterSnap,
  apiKey: string,
  stats: ApiStats,
): Promise<{
  status: "OK" | "MISSING" | "AMBIGUOUS" | "NO_PARCEL" | "ERROR" | "COLLAPSE";
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
    status: "OK" | "MISSING" | "AMBIGUOUS" | "ERROR" | "COLLAPSE";
    item: JsonRec | null;
    error?: string;
  }>("recap", parcelKey);
  if (cached) return { ...cached, parcelKey };
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
      stats,
    );
    await sleep(stats.sleepMs);
    if (!r.ok || !r.items.length) {
      const out = { status: "MISSING" as const, item: null, error: `code=${r.resultCode}` };
      writeCache("recap", parcelKey, out);
      return { ...out, parcelKey };
    }
    if (r.items.length === 1) {
      const out = { status: "OK" as const, item: r.items[0]! };
      writeCache("recap", parcelKey, out);
      return { ...out, parcelKey };
    }
    // SAFE_DUPLICATE_COLLAPSE for FAR/BCR when every row agrees; other fields only if unanimous
    const farVals = r.items.map((it) => num(it.vlRat));
    const bcrVals = r.items.map((it) => num(it.bcRat));
    const same = (vals: Array<number | null>, max: number) => {
      if (!vals.length || vals.some((v) => v == null || !Number.isFinite(v!))) return null;
      const first = vals[0]!;
      if (vals.some((v) => v !== first)) return null;
      if (!(first > 0 && first <= max)) return null;
      return first;
    };
    const far = same(farVals, 2000);
    const bcr = same(bcrVals, 100);
    if (far == null && bcr == null) {
      const out = { status: "AMBIGUOUS" as const, item: null };
      writeCache("recap", parcelKey, out);
      return { ...out, parcelKey };
    }
    const collapsed: JsonRec = {};
    if (far != null) collapsed.vlRat = far;
    if (bcr != null) collapsed.bcRat = bcr;
    const out = { status: "COLLAPSE" as const, item: collapsed };
    writeCache("recap", parcelKey, out);
    return { ...out, parcelKey };
  } catch (e) {
    const out = { status: "ERROR" as const, item: null, error: String(e) };
    writeCache("recap", parcelKey, out);
    return { ...out, parcelKey };
  }
}

export async function fetchKapt(
  kaptCode: string,
  apiKey: string,
  stats: ApiStats,
): Promise<{ basic: JsonRec | null; detail: JsonRec | null; ok: boolean }> {
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
    stats,
  );
  await sleep(stats.sleepMs);
  const dtl = await getJson(
    "/AptBasisInfoServiceV5/getAphusDtlInfoV5",
    { kaptCode },
    apiKey,
    stats,
  );
  await sleep(stats.sleepMs);
  const out = {
    basic: bass.ok ? bass.item : null,
    detail: dtl.ok ? dtl.item : null,
    ok: bass.ok || dtl.ok,
  };
  writeCache("kapt", kaptCode, out);
  return out;
}

export function collectCandidates(args: {
  kaptCode: string | null;
  basic: JsonRec | null;
  detail: JsonRec | null;
  recap: JsonRec | null;
  recapKey: string | null;
  recapSource?: string;
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
  const recapSrc = args.recapSource ?? "BUILDING_HUB_RECAP";

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
      push("parking_total", {
        value: Math.round(p1 + p2),
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
        source: recapSrc,
        source_key: args.recapKey,
        raw: r.hhldCnt,
      });
    const mainBld = num(r.mainBldCnt);
    if (mainBld != null)
      push("building_count", {
        value: Math.round(mainBld),
        source: recapSrc,
        source_key: args.recapKey,
        raw: r.mainBldCnt,
      });
    const ap = normalizeDate(r.useAprDay);
    if (ap)
      push("approval_date", {
        value: ap,
        source: recapSrc,
        source_key: args.recapKey,
        raw: r.useAprDay,
      });
    const far = num(r.vlRat);
    if (far != null)
      push("far_ratio", {
        value: far,
        source: recapSrc,
        source_key: args.recapKey,
        raw: r.vlRat,
      });
    const bcr = num(r.bcRat);
    if (bcr != null)
      push("bcr_ratio", {
        value: bcr,
        source: recapSrc,
        source_key: args.recapKey,
        raw: r.bcRat,
      });
    const pk = num(r.totPkngCnt);
    if (pk != null)
      push("parking_total", {
        value: Math.round(pk),
        source: recapSrc,
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

export function mergeRawMeta(
  existing: string | null,
  patch: Record<string, unknown>,
): string {
  let meta: Record<string, unknown> = {};
  if (existing) {
    try {
      meta = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      meta = { prior_raw_meta: existing };
    }
  }
  const prevProv =
    meta.field_provenance && typeof meta.field_provenance === "object"
      ? { ...(meta.field_provenance as Record<string, unknown>) }
      : {};
  const nextProv =
    patch.field_provenance && typeof patch.field_provenance === "object"
      ? (patch.field_provenance as Record<string, unknown>)
      : {};
  meta.field_provenance = { ...prevProv, ...nextProv };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "field_provenance") continue;
    meta[k] = v;
  }
  return JSON.stringify(meta);
}

export async function upsertSourceLink(
  db: Client,
  source: string,
  sourceKey: string,
  complexId: string,
  meta: Record<string, unknown>,
) {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO apt_complex_source_links (
            source, source_key, complex_id, match_tier, source_meta_json,
            source_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, source_key) DO NOTHING`,
    args: [
      source,
      sourceKey,
      complexId,
      "EXACT",
      JSON.stringify(meta),
      SOURCE_VERSION,
      ts,
      ts,
    ],
  });
}

export async function applyFills(
  db: Client,
  complexId: string,
  existing: ProfileSnap | null,
  fills: Partial<Record<HeroField | "parking_total", Candidate>>,
): Promise<{ inserted: boolean; updated: boolean; fields: string[] }> {
  const fieldNames = Object.keys(fills).filter((k) => fills[k as HeroField]);
  if (!fieldNames.length) return { inserted: false, updated: false, fields: [] };

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
      at: ts,
    };
  }
  const raw = mergeRawMeta(existing?.raw_meta_json ?? null, {
    field_provenance: prov,
    profile_national_at: ts,
  });

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
        "COMPOSITE",
        SOURCE_VERSION,
        raw,
        ts,
      ],
    });
  }

  for (const c of Object.values(fills)) {
    if (!c) continue;
    if (
      c.source === "BUILDING_HUB_RECAP" ||
      c.source === "BUILDING_HUB_DUPLICATE_COLLAPSE"
    ) {
      await upsertSourceLink(db, c.source, String(c.source_key), complexId, {
        fields: fieldNames,
      });
    }
  }

  return {
    inserted: !existing,
    updated: !!existing,
    fields: fieldNames,
  };
}

export function decideFills(
  existing: ProfileSnap | null,
  bags: Partial<Record<HeroField | "parking_total", Candidate[]>>,
): {
  fills: Partial<Record<HeroField | "parking_total", Candidate>>;
  conflicts: number;
  invalid: number;
  ambiguous: number;
} {
  const fills: Partial<Record<HeroField | "parking_total", Candidate>> = {};
  let conflicts = 0;
  let invalid = 0;
  let ambiguous = 0;

  for (const field of HERO_FIELDS) {
    if (field === "parking_per_household") continue;
    const resolved = resolveAgreedCandidate(field, bags[field]);
    if (resolved.ambiguous) {
      ambiguous += 1;
      continue;
    }
    if (resolved.invalid) {
      invalid += 1;
      continue;
    }
    const cand = resolved.candidate;
    if (!cand) continue;
    const cur = existing
      ? ((existing as Record<string, unknown>)[field] as string | number | null)
      : null;
    if (cur == null || cur === "") {
      fills[field] = cand;
      continue;
    }
    const cmp = compareValues(field, cur, cand.value);
    if (cmp === "MATERIAL_DIFFERENCE") conflicts += 1;
  }

  const parkingResolved = resolveAgreedCandidate("parking_total", bags.parking_total);
  if (parkingResolved.ambiguous) ambiguous += 1;
  else if (parkingResolved.invalid) invalid += 1;
  else if (parkingResolved.candidate) {
    const pt = parkingResolved.candidate;
    const curPt = existing?.parking_total ?? null;
    if (curPt == null) {
      fills.parking_total = pt;
    } else if (
      compareValues("parking_total", curPt, pt.value) === "MATERIAL_DIFFERENCE"
    ) {
      conflicts += 1;
    }

    const hhResolved = resolveAgreedCandidate("household_count", [
      ...(bags.household_count ?? []),
      ...(fills.household_count ? [fills.household_count] : []),
    ]);
    const hhVal =
      (existing?.household_count as number | null) ??
      (hhResolved.candidate && typeof hhResolved.candidate.value === "number"
        ? hhResolved.candidate.value
        : null) ??
      (fills.household_count && typeof fills.household_count.value === "number"
        ? fills.household_count.value
        : null);

    if (
      fills.parking_total &&
      hhVal != null &&
      hhVal > 0 &&
      typeof fills.parking_total.value === "number" &&
      (existing?.parking_per_household == null ||
        existing.parking_per_household === (null as unknown))
    ) {
      // only derive when parking filled now and household known; skip if existing PPH set
      if (existing?.parking_per_household == null) {
        const pph = Number(fills.parking_total.value) / hhVal;
        if (isValidField("parking_per_household", pph)) {
          fills.parking_per_household = {
            value: Math.round(pph * 1000) / 1000,
            source: fills.parking_total.source,
            source_key: fills.parking_total.source_key,
            raw: {
              parking_total: fills.parking_total.value,
              household_count: hhVal,
            },
            derived: true,
            derived_tag: "DERIVED_PARKING_PER_HOUSEHOLD",
          };
        }
      }
    }
  }

  return { fills, conflicts, invalid, ambiguous };
}
