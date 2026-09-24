/**
 * Fill empty apt_complex_profile cells from official sources only.
 *
 * Hub: getBrRecapTitleInfo. If the parcel has no 총괄표제부, getBrTitleInfo.
 *   One 총괄 row is used as-is. Several 총괄 rows, or several 아파트 주건축물 title
 *   rows: 용적률/건폐율 only when every row has the same number; 세대수/주차 only
 *   when every row has a number (sum). Mixed or partial rows stay empty.
 * K-apt (linked source_key only): getAphusBassInfoV5 (난방, 복도, 세대수),
 *   getAphusDtlInfoV5 (지상 kaptdPcnt + 지하 kaptdPcntu).
 *
 * NULL cells only. No deletes. Disagreement between hub and K-apt is reported,
 * not written. parking_per_household is derived only when both inputs are official.
 *
 * Usage: ./node_modules/.bin/tsx scripts/profile-fill/fill-complex-profile.mts <diagnose|fetch|plan|apply> [--min-weight N]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  cadastralToRegistryPnu,
  hallOrNull,
  hubFromRows,
  kaptParking,
  numOrNull,
  parkingPerHousehold,
  pickAgreed,
  type Prov,
} from "./rules";

config({ path: ".env.local", quiet: true });

const OUT = "data/poc/profile";
const CACHE = "data/profile-fill-cache";
const START_3Y = "2023-09-24";
const SOURCE_VERSION = "profile_fill_2026_09";
const BATCH = 40;

type Stmt = { sql: string; args: InArgs };

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}
function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

class QuotaError extends Error {}
const apiStats = { calls: 0, retries: 0, http503: 0, http429: 0 };
let spacingMs = Number(process.env.SUPPLY_FILL_SPACING_MS ?? 250);
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pace() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + spacingMs;
  if (wait > 0) await sleep(wait);
}
function perSecond(text: string) {
  return /PER_SECOND|초당 서비스 요청제한/.test(text);
}
function dailyQuota(text: string) {
  if (perSecond(text)) return false;
  return /LIMITED_NUMBER_OF_SERVICE_REQUESTS|SERVICE_REQUESTS_EXCEEDS|"returnReasonCode"\s*:\s*"22"/.test(text);
}

function db(): Client {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
}

async function fetchJson(path: string, qs: Record<string, string>): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const u = new URL(`https://apis.data.go.kr/1613000${path}`);
  u.searchParams.set("serviceKey", key);
  for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  u.searchParams.set("_type", "json");
  let last = "unknown";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pace();
    apiStats.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(u, { headers: { "User-Agent": "ziplab-profile-fill" }, signal: controller.signal });
      const text = await res.text();
      if (!text.includes('"resultCode":"00"') && perSecond(text)) {
        apiStats.http429 += 1;
        spacingMs = Math.min(3000, Math.round(spacingMs * 1.8));
        last = "per-second";
      } else if (!text.includes('"resultCode":"00"') && dailyQuota(text)) {
        throw new QuotaError("QUOTA");
      } else if (res.status === 429 || res.status === 503) {
        if (res.status === 429) apiStats.http429 += 1;
        else apiStats.http503 += 1;
        spacingMs = Math.min(3000, Math.round(spacingMs * 1.6));
        last = String(res.status);
      } else if (!res.ok) last = `HTTP ${res.status}`;
      else {
        const parsed = JSON.parse(text) as {
          response?: { header?: { resultCode?: string }; body?: { totalCount?: unknown; items?: { item?: unknown }; item?: unknown } };
        };
        const code = String(parsed.response?.header?.resultCode ?? "");
        if (code === "00" || code === "0" || code === "000" || code === "03") {
          const body = parsed.response?.body;
          const raw = body?.items?.item ?? body?.item;
          const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
          return { total: Number(body?.totalCount ?? items.length) || items.length, items };
        }
        last = code ? `API ${code}` : "bad-json";
      }
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      last = error instanceof Error && error.name === "AbortError" ? "timeout" : "network";
    } finally {
      clearTimeout(timer);
    }
    apiStats.retries += 1;
    await sleep(700 * (attempt + 1));
  }
  throw new Error(last);
}

function parcelQs(pnu: string): Record<string, string> | null {
  if (!/^\d{19}$/.test(pnu) || (pnu[10] !== "0" && pnu[10] !== "1")) return null;
  return {
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu.slice(10, 11),
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
    numOfRows: "100",
    pageNo: "1",
  };
}

type HubCache = { total: number; items: Record<string, unknown>[] };
type KaptCache = { bass: Record<string, unknown> | null; dtl: Record<string, unknown> | null; bassOk: boolean; dtlOk: boolean };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function ensureHub(pnu: string): Promise<void> {
  const dir = `${CACHE}/hub`;
  mkdirSync(dir, { recursive: true });
  const recapPath = `${dir}/${pnu}.recap.json`;
  const titlePath = `${dir}/${pnu}.title.json`;
  if (existsSync(recapPath) && (readJson<HubCache>(recapPath)!.total > 0 || existsSync(titlePath))) return;
  const qs = parcelQs(pnu);
  if (!qs) throw new Error(`bad pnu ${pnu}`);
  if (!existsSync(recapPath)) {
    const recap = await fetchJson("/BldRgstHubService/getBrRecapTitleInfo", qs);
    writeFileSync(recapPath, JSON.stringify({ total: recap.total, items: recap.items }));
    if (recap.total > 0) return;
  }
  if (!existsSync(titlePath)) {
    const title = await fetchJson("/BldRgstHubService/getBrTitleInfo", qs);
    writeFileSync(titlePath, JSON.stringify({ total: title.total, items: title.items }));
  }
}

async function ensureKapt(code: string, needDtl: boolean): Promise<void> {
  const dir = `${CACHE}/kapt`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${code}.json`;
  const prev = readJson<KaptCache>(file);
  if (prev?.bassOk && (!needDtl || prev.dtlOk)) return;
  const bass = prev?.bassOk
    ? { items: prev.bass ? [prev.bass] : [] }
    : await fetchJson("/AptBasisInfoServiceV5/getAphusBassInfoV5", { kaptCode: code });
  let dtlItems = prev?.dtlOk ? (prev.dtl ? [prev.dtl] : []) : [];
  let dtlOk = Boolean(prev?.dtlOk);
  if (needDtl && !dtlOk) {
    const dtl = await fetchJson("/AptBasisInfoServiceV5/getAphusDtlInfoV5", { kaptCode: code });
    dtlItems = dtl.items;
    dtlOk = true;
  }
  const next: KaptCache = {
    bass: bass.items[0] ?? null,
    dtl: dtlItems[0] ?? null,
    bassOk: true,
    dtlOk,
  };
  writeFileSync(file, JSON.stringify(next));
}

type Profile = {
  household_count: number | null;
  parking_total: number | null;
  parking_per_household: number | null;
  far_ratio: number | null;
  bcr_ratio: number | null;
  heating_type: string | null;
  corridor_type: string | null;
  raw: string;
  hasRow: boolean;
};

type Target = {
  complexId: string;
  pnu: string;
  pnuStatus: string;
  kapt: string;
  kaptStatus: string;
  weight: number;
  profile: Profile;
};

async function loadTargets(client: Client): Promise<{ targets: Target[]; tradedIds: number }> {
  const profiles = new Map<string, Profile>();
  const hasCorridor = (await client.execute("PRAGMA table_info(apt_complex_profile)")).rows.some((r) => r.name === "corridor_type");
  const prof = await client.execute(
    `SELECT complex_id, household_count, parking_total, parking_per_household, far_ratio, bcr_ratio, heating_type, raw_meta_json${hasCorridor ? ", corridor_type" : ""} FROM apt_complex_profile`,
  );
  for (const row of prof.rows) {
    profiles.set(str(row.complex_id), {
      household_count: row.household_count == null ? null : num(row.household_count),
      parking_total: row.parking_total == null ? null : num(row.parking_total),
      parking_per_household: row.parking_per_household == null ? null : Number(row.parking_per_household),
      far_ratio: row.far_ratio == null ? null : Number(row.far_ratio),
      bcr_ratio: row.bcr_ratio == null ? null : Number(row.bcr_ratio),
      heating_type: row.heating_type == null ? null : str(row.heating_type),
      corridor_type: hasCorridor && row.corridor_type != null ? str(row.corridor_type) : null,
      raw: str(row.raw_meta_json),
      hasRow: true,
    });
  }
  const empty = (): Profile => ({
    household_count: null,
    parking_total: null,
    parking_per_household: null,
    far_ratio: null,
    bcr_ratio: null,
    heating_type: null,
    corridor_type: null,
    raw: "",
    hasRow: false,
  });

  const recap = new Map<string, string[]>();
  for (const row of (await client.execute(`SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = 'BUILDING_HUB_RECAP'`)).rows) {
    const list = recap.get(str(row.complex_id)) ?? [];
    list.push(str(row.source_key));
    recap.set(str(row.complex_id), list);
  }
  const kapts = new Map<string, string[]>();
  for (const row of (await client.execute(`SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = 'KAPT'`)).rows) {
    const list = kapts.get(str(row.complex_id)) ?? [];
    list.push(str(row.source_key));
    kapts.set(str(row.complex_id), list);
  }
  const cachePnu = new Map<string, Set<string>>();
  for (const row of (await client.execute(`SELECT complex_id, pnu FROM official_unit_area_cache WHERE pnu <> ''`)).rows) {
    const set = cachePnu.get(str(row.complex_id)) ?? new Set<string>();
    set.add(str(row.pnu));
    cachePnu.set(str(row.complex_id), set);
  }
  const cpc = new Map<string, string>();
  for (const row of (await client.execute(`SELECT complex_id, pnu FROM complex_parcel_coordinates WHERE pnu IS NOT NULL AND pnu <> ''`)).rows) {
    cpc.set(str(row.complex_id), cadastralToRegistryPnu(str(row.pnu)));
  }
  const weight = new Map<string, number>();
  for (const row of (await client.execute(`SELECT complex_id, SUM(trade_count_3y) AS c3 FROM apt_unit_exclusive_pairs GROUP BY complex_id`)).rows) {
    weight.set(str(row.complex_id), num(row.c3));
  }
  const masters = await client.execute(`SELECT complex_id, lawd_cd FROM apt_complex_master`);
  const targets: Target[] = [];
  let tradedIds = 0;
  for (const row of masters.rows) {
    const id = str(row.complex_id);
    const lawd = str(row.lawd_cd);
    const w = weight.get(id) ?? 0;
    if (w > 0) tradedIds += 1;
    const recaps = [...new Set((recap.get(id) ?? []).filter((p) => /^\d{19}$/.test(p)))];
    const caches = [...(cachePnu.get(id) ?? [])];
    let cpcPnu = cpc.get(id) ?? "";
    if (cpcPnu && cpcPnu.slice(0, 5) !== lawd) cpcPnu = "";
    const candidates = [...new Set([...recaps, ...caches, ...(cpcPnu ? [cpcPnu] : [])])];
    let pnu = "";
    let pnuStatus = "NO_PARCEL";
    if (candidates.length === 1) {
      pnu = candidates[0]!;
      pnuStatus = "OK";
    } else if (candidates.length > 1) pnuStatus = "PNU_CONFLICT";
    const kaptKeys = [...new Set(kapts.get(id) ?? [])];
    let kapt = "";
    let kaptStatus = "NO_KAPT";
    if (kaptKeys.length === 1 && /^A\d+$/.test(kaptKeys[0]!)) {
      kapt = kaptKeys[0]!;
      kaptStatus = "OK";
    } else if (kaptKeys.length > 1) kaptStatus = "KAPT_CONFLICT";
    targets.push({ complexId: id, pnu, pnuStatus, kapt, kaptStatus, weight: w, profile: profiles.get(id) ?? empty() });
  }
  return { targets, tradedIds };
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

async function diagnose(client: Client) {
  const { targets, tradedIds } = await loadTargets(client);
  const fields = ["far_ratio", "bcr_ratio", "parking_total", "household_count", "heating_type", "corridor_type", "parking_per_household"] as const;
  const emptyCause: Record<string, Record<string, number>> = {};
  const emptyCauseTraded: Record<string, Record<string, number>> = {};
  const filled = Object.fromEntries(fields.map((f) => [f, 0])) as Record<(typeof fields)[number], number>;
  const filledTraded = { ...filled };
  let noRow = 0;
  let noRowTraded = 0;
  for (const t of targets) {
    const traded = t.weight > 0;
    if (!t.profile.hasRow) {
      noRow += 1;
      if (traded) noRowTraded += 1;
    }
    for (const field of fields) {
      const value = t.profile[field === "far_ratio" ? "far_ratio" : field === "bcr_ratio" ? "bcr_ratio" : field === "parking_total" ? "parking_total" : field === "household_count" ? "household_count" : field === "heating_type" ? "heating_type" : field === "corridor_type" ? "corridor_type" : "parking_per_household"];
      if (value != null && value !== "") {
        filled[field] += 1;
        if (traded) filledTraded[field] += 1;
        continue;
      }
      let cause = "HAS_IDENTITY";
      if (!t.profile.hasRow) cause = "NO_PROFILE_ROW";
      else if (field === "heating_type" || field === "corridor_type") cause = t.kaptStatus === "OK" ? "HAS_KAPT_UNFETCHED" : t.kaptStatus;
      else if (field === "far_ratio" || field === "bcr_ratio") cause = t.pnuStatus === "OK" ? "HAS_PARCEL_UNFETCHED" : t.pnuStatus;
      else if (t.pnuStatus !== "OK" && t.kaptStatus !== "OK") cause = t.pnuStatus === "NO_PARCEL" && t.kaptStatus === "NO_KAPT" ? "NO_PARCEL_AND_NO_KAPT" : `${t.pnuStatus}+${t.kaptStatus}`;
      else cause = "HAS_IDENTITY_UNFETCHED";
      const slot = (emptyCause[field] ??= {});
      bump(slot, cause);
      if (traded) bump(emptyCauseTraded[field] ??= {}, cause);
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    window3y: `apt_unit_exclusive_pairs.trade_count_3y > 0 (deal window used by the pair ledger, from ${START_3Y})`,
    master: targets.length,
    profileRows: targets.filter((t) => t.profile.hasRow).length,
    noProfileRow: noRow,
    noProfileRowTraded: noRowTraded,
    tradedComplexes: tradedIds,
    pnu: {
      ok: targets.filter((t) => t.pnuStatus === "OK").length,
      conflict: targets.filter((t) => t.pnuStatus === "PNU_CONFLICT").length,
      missing: targets.filter((t) => t.pnuStatus === "NO_PARCEL").length,
    },
    kapt: {
      ok: targets.filter((t) => t.kaptStatus === "OK").length,
      conflict: targets.filter((t) => t.kaptStatus === "KAPT_CONFLICT").length,
      missing: targets.filter((t) => t.kaptStatus === "NO_KAPT").length,
    },
    filled,
    filledTraded,
    emptyCause,
    emptyCauseTraded,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/gap-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ master: report.master, traded: tradedIds, noRow, pnu: report.pnu, kapt: report.kapt, filled, filledTraded }, null, 2));
}

function filtered(targets: Target[]): Target[] {
  const min = Number(arg("--min-weight") ?? 0);
  const list = min > 0 ? targets.filter((t) => t.weight >= min) : targets;
  list.sort((a, b) => b.weight - a.weight || a.complexId.localeCompare(b.complexId));
  return list;
}

async function fetchPhase(client: Client) {
  const { targets } = await loadTargets(client);
  const list = filtered(targets);
  const pnus = [...new Set(list.filter((t) => t.pnuStatus === "OK" && (t.profile.far_ratio == null || t.profile.bcr_ratio == null || t.profile.household_count == null || t.profile.parking_total == null)).map((t) => t.pnu))];
  const bass = [...new Set(list.filter((t) => t.kaptStatus === "OK" && (t.profile.heating_type == null || t.profile.corridor_type == null || t.profile.household_count == null)).map((t) => t.kapt))];
  const dtl = [...new Set(list.filter((t) => t.kaptStatus === "OK" && t.profile.parking_total == null).map((t) => t.kapt))];
  console.log(JSON.stringify({ targets: list.length, hubParcels: pnus.length, kaptBass: bass.length, kaptDtl: dtl.length }));
  let quota = false;
  const failed: string[] = [];
  async function run(ids: string[], kind: "hub" | "kapt", needDtl = false) {
    for (const id of ids) {
      if (quota) return;
      try {
        if (kind === "hub") await ensureHub(id);
        else await ensureKapt(id, needDtl);
      } catch (error) {
        if (error instanceof QuotaError) {
          quota = true;
          return;
        }
        failed.push(`${kind}:${id}:${error instanceof Error ? error.message : "error"}`);
      }
      const n = apiStats.calls;
      if (n > 0 && n % 200 === 0) console.log(JSON.stringify({ progressCalls: n, ...apiStats, failed: failed.length }));
    }
  }
  await run(pnus, "hub");
  await run([...new Set([...bass, ...dtl])], "kapt", false);
  if (!quota) {
    const need = new Set(dtl);
    await run([...need], "kapt", true);
  }
  const summary = { quotaStop: quota, failed: failed.length, failedSample: failed.slice(0, 20), ...apiStats };
  writeFileSync(`${OUT}/fetch-summary.json`, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2));
  console.log(JSON.stringify(summary));
}

type Planned = {
  complexId: string;
  insert: boolean;
  sets: Record<string, string | number>;
  prov: Record<string, Prov>;
  conflicts: Array<{ field: string; hub: number | null; kapt: number | null; existing: number | string | null }>;
};

function planOne(t: Target): Planned | null {
  const recap = t.pnu ? readJson<HubCache>(`${CACHE}/hub/${t.pnu}.recap.json`) : null;
  const title = t.pnu ? readJson<HubCache>(`${CACHE}/hub/${t.pnu}.title.json`) : null;
  const kapt = t.kapt ? readJson<KaptCache>(`${CACHE}/kapt/${t.kapt}.json`) : null;
  const hub = recap ? hubFromRows(recap.items, title?.items ?? []) : null;
  const hubSource = hub?.rule === "RECAP" ? "BUILDING_HUB_RECAP" : "BUILDING_HUB_TITLE";
  const kHousehold = numOrNull(kapt?.bass?.kaptdaCnt);
  const kPark = kapt?.dtlOk ? kaptParking(kapt.dtl) : null;
  const kHeat = kapt?.bassOk ? str(kapt.bass?.codeHeatNm) : "";
  const kHall = kapt?.bassOk ? hallOrNull(kapt.bass?.codeHallNm) : null;
  const hh = pickAgreed(hub?.household ?? null, kHousehold);
  const park = pickAgreed(hub?.parking != null ? Math.trunc(hub.parking) : null, kPark != null ? Math.trunc(kPark) : null);
  const sets: Record<string, string | number> = {};
  const prov: Record<string, Prov> = {};
  const conflicts: Planned["conflicts"] = [];
  if (hh.conflict) conflicts.push({ field: "household_count", hub: hub?.household ?? null, kapt: kHousehold, existing: t.profile.household_count });
  if (park.conflict) conflicts.push({ field: "parking_total", hub: hub?.parking ?? null, kapt: kPark, existing: t.profile.parking_total });

  function takeNumber(field: "far_ratio" | "bcr_ratio" | "household_count" | "parking_total", value: number | null, source: string, key: string, tag: string | null) {
    if (value == null) return;
    const existing = t.profile[field];
    if (existing != null) {
      if (existing !== value) conflicts.push({ field, hub: source.startsWith("BUILDING") ? value : null, kapt: source.startsWith("KAPT") ? value : null, existing });
      return;
    }
    sets[field] = value;
    prov[field] = { source, source_key: key, derived: false, derived_tag: tag, raw: value };
  }
  if (hub) {
    const tag = hub.rule === "TITLE_SUM_MAIN_APT" ? "SUM_TITLE_MAIN_APT" : null;
    takeNumber("far_ratio", hub.far, hubSource, t.pnu, tag);
    takeNumber("bcr_ratio", hub.bcr, hubSource, t.pnu, tag);
  }
  if (!hh.conflict && hh.value != null) {
    const source = hub?.household != null ? hubSource : "KAPT_BASIC_V5";
    const key = hub?.household != null ? t.pnu : t.kapt;
    takeNumber("household_count", hh.value, source, key, hub?.rule === "TITLE_SUM_MAIN_APT" && hub.household != null ? "SUM_TITLE_MAIN_APT" : null);
  }
  if (!park.conflict && park.value != null) {
    const source = hub?.parking != null ? hubSource : "KAPT_DETAIL_V5";
    const key = hub?.parking != null ? t.pnu : t.kapt;
    takeNumber("parking_total", park.value, source, key, hub?.rule === "TITLE_SUM_MAIN_APT" && hub.parking != null ? "SUM_TITLE_MAIN_APT" : null);
  }
  if (kHeat && t.profile.heating_type == null) {
    sets.heating_type = kHeat;
    prov.heating_type = { source: "KAPT_BASIC_V5", source_key: t.kapt, derived: false, derived_tag: null, raw: kHeat };
  } else if (kHeat && t.profile.heating_type && t.profile.heating_type !== kHeat) {
    conflicts.push({ field: "heating_type", hub: null, kapt: null, existing: t.profile.heating_type });
  }
  if (kHall && t.profile.corridor_type == null) {
    sets.corridor_type = kHall;
    prov.corridor_type = { source: "KAPT_BASIC_V5", source_key: t.kapt, derived: false, derived_tag: null, raw: kHall };
  }
  const hhNow = t.profile.household_count ?? (typeof sets.household_count === "number" ? sets.household_count : null);
  const parkNow = t.profile.parking_total ?? (typeof sets.parking_total === "number" ? sets.parking_total : null);
  const hhOfficial = (t.profile.household_count != null && !hh.conflict) || typeof sets.household_count === "number";
  const parkOfficial = (t.profile.parking_total != null && !park.conflict) || typeof sets.parking_total === "number";
  if (t.profile.parking_per_household == null && hhOfficial && parkOfficial && hhNow != null && parkNow != null) {
    const derived = parkingPerHousehold(Math.trunc(parkNow), Math.trunc(hhNow));
    if (derived != null) {
      sets.parking_per_household = derived;
      prov.parking_per_household = {
        source: prov.parking_total?.source ?? prov.household_count?.source ?? "BUILDING_HUB_RECAP",
        source_key: prov.parking_total?.source_key ?? prov.household_count?.source_key ?? t.pnu,
        derived: true,
        derived_tag: "DERIVED_PARKING_PER_HOUSEHOLD",
        raw: { parking_total: Math.trunc(parkNow), household_count: Math.trunc(hhNow) },
      };
    }
  }
  if (Object.keys(sets).length === 0 && conflicts.length === 0) return null;
  return { complexId: t.complexId, insert: !t.profile.hasRow && Object.keys(sets).length > 0, sets, prov, conflicts };
}

function statements(plan: Planned, now: string, existingRaw: string): Stmt[] {
  if (Object.keys(plan.sets).length === 0) return [];
  let meta: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      meta = JSON.parse(existingRaw) as Record<string, unknown>;
    } catch {
      meta = { previous_raw: existingRaw.slice(0, 200) };
    }
  }
  const prev = (meta.field_provenance ?? {}) as Record<string, Prov>;
  meta.field_provenance = { ...prev, ...plan.prov };
  meta.profile_fill = SOURCE_VERSION;
  if (plan.insert) {
    const cols = ["complex_id", ...Object.keys(plan.sets), "source", "source_version", "raw_meta_json", "updated_at"];
    const args: InArgs = [plan.complexId, ...Object.values(plan.sets), "PROFILE_FILL", SOURCE_VERSION, JSON.stringify(meta), now];
    return [{
      sql: `INSERT INTO apt_complex_profile (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT(complex_id) DO NOTHING`,
      args,
    }];
  }
  const assigns = Object.keys(plan.sets).map((col) => `${col} = COALESCE(${col}, ?)`);
  assigns.push("raw_meta_json = ?", "updated_at = ?");
  return [{
    sql: `UPDATE apt_complex_profile SET ${assigns.join(", ")} WHERE complex_id = ?`,
    args: [...Object.values(plan.sets), JSON.stringify(meta), now, plan.complexId],
  }];
}

async function ensureCorridor(client: Client) {
  const cols = (await client.execute("PRAGMA table_info(apt_complex_profile)")).rows.map((r) => str(r.name));
  if (cols.includes("corridor_type")) return;
  await client.execute("ALTER TABLE apt_complex_profile ADD COLUMN corridor_type TEXT");
}

async function planPhase(client: Client, apply: boolean) {
  if (apply) await ensureCorridor(client);
  const { targets } = await loadTargets(client);
  const list = filtered(targets);
  const pnuCount = new Map<string, number>();
  const kaptCount = new Map<string, number>();
  for (const t of targets) {
    if (t.pnu) pnuCount.set(t.pnu, (pnuCount.get(t.pnu) ?? 0) + 1);
    if (t.kapt) kaptCount.set(t.kapt, (kaptCount.get(t.kapt) ?? 0) + 1);
  }
  const totals = {
    targets: list.length,
    plannedComplexes: 0,
    inserts: 0,
    updates: 0,
    byField: {} as Record<string, number>,
    sharedParcelHold: 0,
    sharedKaptHold: 0,
    conflicts: 0,
    appliedChanges: 0,
  };
  const conflictRows: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const stmts: Stmt[] = [];
  for (const t of list) {
    if (t.pnu && (pnuCount.get(t.pnu) ?? 0) > 1) {
      totals.sharedParcelHold += 1;
      t.pnu = "";
    }
    if (t.kapt && (kaptCount.get(t.kapt) ?? 0) > 1) {
      totals.sharedKaptHold += 1;
      t.kapt = "";
    }
    const plan = planOne(t);
    if (!plan) continue;
    if (plan.conflicts.length) {
      totals.conflicts += plan.conflicts.length;
      conflictRows.push({ complexId: t.complexId, conflicts: plan.conflicts });
    }
    if (Object.keys(plan.sets).length === 0) continue;
    totals.plannedComplexes += 1;
    if (plan.insert) totals.inserts += 1;
    else totals.updates += 1;
    for (const field of Object.keys(plan.sets)) totals.byField[field] = (totals.byField[field] ?? 0) + 1;
    stmts.push(...statements(plan, now, t.profile.raw));
  }
  if (apply) {
    for (const part of chunks(stmts, BATCH)) {
      const results = await client.batch(part, "write");
      totals.appliedChanges += results.reduce((n, r) => n + r.rowsAffected, 0);
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${apply ? "apply" : "plan"}.json`, JSON.stringify({ at: now, apply, totals }, null, 2));
  writeFileSync(`${OUT}/conflicts.json`, JSON.stringify(conflictRows, null, 1));
  console.log(JSON.stringify({ apply, statements: stmts.length, ...totals }, null, 2));
}

async function main() {
  const phase = process.argv[2] ?? "diagnose";
  const client = db();
  mkdirSync(OUT, { recursive: true });
  if (phase === "diagnose") await diagnose(client);
  else if (phase === "fetch") await fetchPhase(client);
  else if (phase === "plan") await planPhase(client, false);
  else if (phase === "apply") await planPhase(client, true);
  else throw new Error(`unknown phase ${phase}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  });
}
