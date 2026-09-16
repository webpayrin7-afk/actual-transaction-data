/**
 * MANAGEMENT STAGE M3 — Full-Seoul KAPT identity discovery.
 * AptListService4/getSigunguAptList4 × 25 sigungu.
 * HARD MAX 40 live calls. First 429 → STOP.
 * BasisInfo/management fee/AptIdInfo: 0. Production writes: 0.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  RESOLVER_VERSION,
  matchDistrict,
  type KaptListItem,
  type MasterRow,
  type Pair,
} from "./lib/kapt-identity-resolver";

config({ path: ".env.local" });
config();

const API_BASE = "https://apis.data.go.kr/1613000";
const SERVICE_KEY = process.env.MOLIT_API_KEY?.trim();
const MAX_CALLS = 40;
const PAGE_SIZE = 5000;

const OUT_DIR = join(process.cwd(), "data/poc/management");
const CACHE_DIR = join(process.cwd(), "data/poc/management/cache/kapt-list");
const M2_CACHE = "/tmp/cursor-m2-kapt-cache";
const DISCOVERY_OUT = join(
  OUT_DIR,
  "stage-m3-seoul-kapt-identity-discovery.json",
);
const MANIFEST_OUT = join(
  OUT_DIR,
  "stage-m3-seoul-kapt-identity-promotion-manifest.json",
);
const AMBIGUOUS_OUT = join(
  OUT_DIR,
  "stage-m3-kapt-ambiguous-samples.json",
);

type Json = Record<string, unknown>;

type DistrictMeta = { name: string; sigunguCode: string };

let apiCallsAttempted = 0;
let apiCallsSuccessful = 0;
let cacheHits = 0;
let hit429 = false;
let hit429Detail: {
  endpoint: string;
  requestNumber: number;
  district: string;
  page: number;
} | null = null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cachePath(sigunguCode: string, pageNo: number): string {
  return join(CACHE_DIR, `getSigunguAptList4_${sigunguCode}_p${pageNo}.json`);
}

function seedCacheFromM2(sigunguCode: string) {
  const src = join(M2_CACHE, `getSigunguAptList4_${sigunguCode}_p1.json`);
  const dst = cachePath(sigunguCode, 1);
  if (existsSync(src) && !existsSync(dst)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    copyFileSync(src, dst);
  }
}

async function fetchSigunguPage(
  sigunguCode: string,
  districtName: string,
  pageNo: number,
): Promise<{ items: KaptListItem[]; totalCount: number; fromCache: boolean }> {
  const cp = cachePath(sigunguCode, pageNo);
  if (existsSync(cp)) {
    cacheHits += 1;
    const cached = JSON.parse(readFileSync(cp, "utf8")) as {
      items: KaptListItem[];
      totalCount: number;
    };
    return {
      items: cached.items ?? [],
      totalCount: Number(cached.totalCount ?? 0),
      fromCache: true,
    };
  }

  if (hit429 || apiCallsAttempted >= MAX_CALLS) {
    return { items: [], totalCount: 0, fromCache: false };
  }

  apiCallsAttempted += 1;
  const url =
    `${API_BASE}/AptListService4/getSigunguAptList4` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
    `&sigunguCode=${encodeURIComponent(sigunguCode)}` +
    `&numOfRows=${PAGE_SIZE}&pageNo=${pageNo}&_type=json`;

  const res = await fetch(url);
  if (res.status === 429) {
    hit429 = true;
    hit429Detail = {
      endpoint: "/AptListService4/getSigunguAptList4",
      requestNumber: apiCallsAttempted,
      district: districtName,
      page: pageNo,
    };
    return { items: [], totalCount: 0, fromCache: false };
  }
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} getSigunguAptList4 ${sigunguCode} p${pageNo}`,
    );
  }

  const json = (await res.json()) as Json;
  const body = (json.response as Json | undefined)?.body as Json | undefined;
  const totalCount = Number(body?.totalCount ?? 0);
  const rawItems = body?.items;
  let items: KaptListItem[] = [];
  if (Array.isArray(rawItems)) items = rawItems as KaptListItem[];
  else if (
    rawItems &&
    typeof rawItems === "object" &&
    Array.isArray((rawItems as Json).item)
  ) {
    items = (rawItems as Json).item as KaptListItem[];
  } else if (
    rawItems &&
    typeof rawItems === "object" &&
    (rawItems as Json).kaptCode
  ) {
    items = [rawItems as unknown as KaptListItem];
  }

  const normalized = items.map((it) => ({
    kaptCode: String(it.kaptCode ?? ""),
    kaptName: String(it.kaptName ?? ""),
    bjdCode: String(it.bjdCode ?? ""),
    as1: it.as1 != null ? String(it.as1) : undefined,
    as2: it.as2 != null ? String(it.as2) : undefined,
    as3: it.as3 != null ? String(it.as3) : undefined,
    as4: it.as4 != null ? String(it.as4) : undefined,
  }));

  apiCallsSuccessful += 1;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    cp,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        sigunguCode,
        districtName,
        pageNo,
        totalCount,
        itemCount: normalized.length,
        items: normalized,
      },
      null,
      2,
    ),
  );
  await sleep(150);
  return { items: normalized, totalCount, fromCache: false };
}

async function discoverDistrict(d: DistrictMeta): Promise<{
  items: KaptListItem[];
  pages: number;
  totalCountReported: number;
  status: "OK" | "429_STOP" | "BUDGET_STOP" | "EMPTY";
}> {
  seedCacheFromM2(d.sigunguCode);
  const all: KaptListItem[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalCountReported = 0;
  let pages = 0;

  while (!hit429 && (apiCallsAttempted < MAX_CALLS || existsSync(cachePath(d.sigunguCode, page)))) {
    // Allow cache-only continuation even if budget exhausted for live calls
    const hasCache = existsSync(cachePath(d.sigunguCode, page));
    if (!hasCache && (hit429 || apiCallsAttempted >= MAX_CALLS)) break;

    const { items, totalCount, fromCache } = await fetchSigunguPage(
      d.sigunguCode,
      d.name,
      page,
    );
    if (!fromCache && items.length === 0 && totalCount === 0) {
      if (hit429) return { items: all, pages, totalCountReported, status: "429_STOP" };
      if (page === 1) return { items: all, pages, totalCountReported, status: "EMPTY" };
      break;
    }
    pages += 1;
    if (totalCount > 0) totalCountReported = totalCount;
    for (const it of items) {
      if (!it.kaptCode || seen.has(it.kaptCode)) continue;
      seen.add(it.kaptCode);
      all.push(it);
    }
    if (totalCountReported > 0 && all.length >= totalCountReported) break;
    if (items.length < PAGE_SIZE) break;
    page += 1;
    if (page > 5) break;
  }

  if (hit429 && all.length === 0) {
    return { items: all, pages, totalCountReported, status: "429_STOP" };
  }
  return { items: all, pages, totalCountReported, status: "OK" };
}

async function main() {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // Canonical 25 Seoul sigungu from master
  const sigRows = await db.execute(`
    SELECT sigungu AS name, substr(lawd_cd,1,5) AS sigunguCode, COUNT(*) AS c
    FROM apt_complex_master
    WHERE sido_code='11' AND sigungu IS NOT NULL AND length(lawd_cd)>=5
    GROUP BY sigungu, substr(lawd_cd,1,5)
    ORDER BY sigunguCode
  `);
  const districts: DistrictMeta[] = sigRows.rows.map((r) => ({
    name: String(r.name),
    sigunguCode: String(r.sigunguCode),
  }));
  if (districts.length !== 25) {
    throw new Error(`Expected 25 Seoul sigungu, got ${districts.length}`);
  }

  const seoulCount = Number(
    (
      await db.execute(
        `SELECT COUNT(*) c FROM apt_complex_master WHERE sido_code='11'`,
      )
    ).rows[0]!.c,
  );

  // Existing source links + profile meta
  const linkRows = await db.execute(`
    SELECT l.complex_id, l.source_key, m.sigungu, m.apt_name
    FROM apt_complex_source_links l
    JOIN apt_complex_master m ON m.complex_id=l.complex_id
    WHERE l.source='KAPT' AND m.sido_code='11'
  `);
  const existingByComplex = new Map<string, string>();
  const existingByKapt = new Map<string, string>();
  for (const r of linkRows.rows) {
    existingByComplex.set(String(r.complex_id), String(r.source_key));
    existingByKapt.set(String(r.source_key), String(r.complex_id));
  }

  const profileMeta = await db.execute(`
    SELECT m.complex_id, p.raw_meta_json
    FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.sido_code='11' AND p.raw_meta_json IS NOT NULL
  `);
  const metaByComplex = new Map<string, string>();
  for (const r of profileMeta.rows) {
    try {
      const meta = JSON.parse(String(r.raw_meta_json)) as { kaptCode?: string };
      if (meta.kaptCode && String(meta.kaptCode).startsWith("A")) {
        metaByComplex.set(String(r.complex_id), String(meta.kaptCode));
      }
    } catch {
      /* ignore */
    }
  }

  // Current ID-ready (M1 definition): source_link OR profile_meta
  const idReadySet = new Set<string>([
    ...existingByComplex.keys(),
    ...metaByComplex.keys(),
  ]);
  const currentIdReady = idReadySet.size;

  // Management coverage for future population estimate
  const feeUsable = await db.execute(`
    SELECT complex_id,
      SUM(CASE WHEN common_fee IS NOT NULL AND individual_fee IS NOT NULL
                AND long_term_repair_reserve IS NOT NULL
                AND period_yyyymm BETWEEN '202509' AND '202608' THEN 1 ELSE 0 END) AS usable
    FROM apt_complex_mgmt_fee_monthly
    GROUP BY complex_id
  `);
  const usableByComplex = new Map<string, number>();
  for (const r of feeUsable.rows) {
    usableByComplex.set(String(r.complex_id), Number(r.usable));
  }

  const allMasters = await db.execute(`
    SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun,
           sigungu, legal_dong_name
    FROM apt_complex_master
    WHERE sido_code='11'
  `);
  const mastersBySigungu = new Map<string, MasterRow[]>();
  for (const r of allMasters.rows) {
    const row: MasterRow = {
      complexId: String(r.complex_id),
      aptName: String(r.apt_name),
      aptNameNorm: String(r.apt_name_norm ?? r.apt_name),
      lawdCd: String(r.lawd_cd ?? ""),
      bjdongCd: r.bjdong_cd != null ? String(r.bjdong_cd) : null,
      jibun: r.jibun != null ? String(r.jibun) : null,
      sigungu: String(r.sigungu),
      legalDongName:
        r.legal_dong_name != null ? String(r.legal_dong_name) : null,
    };
    const arr = mastersBySigungu.get(row.sigungu) ?? [];
    arr.push(row);
    mastersBySigungu.set(row.sigungu, arr);
  }

  const districtReports: Record<
    string,
    {
      master: number;
      kaptDiscovered: number;
      totalCountReported: number;
      pages: number;
      status: string;
      EXACT_SAFE: number;
      HIGH_CONFIDENCE: number;
      AMBIGUOUS: number;
      KAPT_ONLY: number;
      MASTER_ONLY: number;
      safeRatePct: number;
      kaptSafeRatePct: number;
    }
  > = {};

  const allKaptByCode = new Map<string, KaptListItem>();
  let rawRecords = 0;
  const allPairs: Pair[] = [];
  const totals = {
    EXACT_SAFE: 0,
    HIGH_CONFIDENCE: 0,
    AMBIGUOUS: 0,
    KAPT_ONLY: 0,
    MASTER_ONLY: 0,
  };
  const ambiguousSamples: Array<{
    district: string;
    kaptCode?: string;
    kaptName?: string;
    kaptAs3?: string;
    masterComplexId: string;
    masterName: string;
    reason: string;
  }> = [];

  const completedDistricts: string[] = [];
  const remainingDistricts: string[] = [];

  for (const d of districts) {
    if (hit429 && !existsSync(cachePath(d.sigunguCode, 1))) {
      remainingDistricts.push(d.name);
      districtReports[d.name] = {
        master: (mastersBySigungu.get(d.name) ?? []).length,
        kaptDiscovered: 0,
        totalCountReported: 0,
        pages: 0,
        status: "429_SKIPPED",
        EXACT_SAFE: 0,
        HIGH_CONFIDENCE: 0,
        AMBIGUOUS: 0,
        KAPT_ONLY: 0,
        MASTER_ONLY: (mastersBySigungu.get(d.name) ?? []).length,
        safeRatePct: 0,
        kaptSafeRatePct: 0,
      };
      continue;
    }

    const discovery = await discoverDistrict(d);
    if (discovery.status === "429_STOP" && discovery.items.length === 0) {
      remainingDistricts.push(d.name);
      districtReports[d.name] = {
        master: (mastersBySigungu.get(d.name) ?? []).length,
        kaptDiscovered: 0,
        totalCountReported: 0,
        pages: discovery.pages,
        status: "429_STOP",
        EXACT_SAFE: 0,
        HIGH_CONFIDENCE: 0,
        AMBIGUOUS: 0,
        KAPT_ONLY: 0,
        MASTER_ONLY: (mastersBySigungu.get(d.name) ?? []).length,
        safeRatePct: 0,
        kaptSafeRatePct: 0,
      };
      continue;
    }

    completedDistricts.push(d.name);
    rawRecords += discovery.items.length;
    for (const it of discovery.items) {
      if (!allKaptByCode.has(it.kaptCode)) allKaptByCode.set(it.kaptCode, it);
    }

    const masters = mastersBySigungu.get(d.name) ?? [];
    const match = matchDistrict(masters, discovery.items);
    allPairs.push(...match.pairs);
    totals.EXACT_SAFE += match.counts.EXACT_SAFE;
    totals.HIGH_CONFIDENCE += match.counts.HIGH_CONFIDENCE;
    totals.AMBIGUOUS += match.counts.AMBIGUOUS;
    totals.KAPT_ONLY += match.counts.KAPT_ONLY;
    totals.MASTER_ONLY += match.counts.MASTER_ONLY;

    for (const mid of match.ambiguousMaster.slice(0, 3)) {
      if (ambiguousSamples.length >= 20) break;
      const m = masters.find((x) => x.complexId === mid);
      if (!m) continue;
      ambiguousSamples.push({
        district: d.name,
        masterComplexId: mid,
        masterName: m.aptName,
        reason: "multiple_plausible_kapt_or_master_candidates_same_bjd",
      });
    }

    const safe = match.counts.EXACT_SAFE + match.counts.HIGH_CONFIDENCE;
    districtReports[d.name] = {
      master: masters.length,
      kaptDiscovered: discovery.items.length,
      totalCountReported: discovery.totalCountReported,
      pages: discovery.pages,
      status: discovery.status,
      EXACT_SAFE: match.counts.EXACT_SAFE,
      HIGH_CONFIDENCE: match.counts.HIGH_CONFIDENCE,
      AMBIGUOUS: match.counts.AMBIGUOUS,
      KAPT_ONLY: match.counts.KAPT_ONLY,
      MASTER_ONLY: match.counts.MASTER_ONLY,
      safeRatePct:
        masters.length === 0
          ? 0
          : Math.round((safe / masters.length) * 10000) / 100,
      kaptSafeRatePct:
        discovery.items.length === 0
          ? 0
          : Math.round((safe / discovery.items.length) * 10000) / 100,
    };
  }

  // Fill remaining if 429 mid-run
  for (const d of districts) {
    if (!completedDistricts.includes(d.name) && !remainingDistricts.includes(d.name)) {
      remainingDistricts.push(d.name);
    }
  }

  const uniqueKapt = allKaptByCode.size;
  const crossDupes = rawRecords - uniqueKapt;

  // Known-link validation (source_links)
  let knownCorrect = 0;
  let knownMissed = 0;
  let knownWrong = 0;
  let knownConflicts = 0;
  const knownMissSample: Array<{ complexId: string; expected: string }> = [];
  const knownWrongSample: Array<{
    complexId: string;
    expected: string;
    got: string;
  }> = [];
  const pairByComplex = new Map(allPairs.map((p) => [p.master.complexId, p]));

  for (const [cid, kapt] of existingByComplex) {
    const hit = pairByComplex.get(cid);
    if (!hit) {
      knownMissed += 1;
      if (knownMissSample.length < 20) {
        knownMissSample.push({ complexId: cid, expected: kapt });
      }
      continue;
    }
    if (hit.kapt.kaptCode !== kapt) {
      knownWrong += 1;
      if (knownWrongSample.length < 20) {
        knownWrongSample.push({
          complexId: cid,
          expected: kapt,
          got: hit.kapt.kaptCode,
        });
      }
    } else {
      knownCorrect += 1;
    }
  }

  // Classify safe pairs for promotion
  type PromoClass =
    | "ALREADY_LINKED_SAME"
    | "NEW_PROMOTABLE"
    | "EXISTING_LINK_CONFLICT";

  const classified: Array<{
    pair: Pair;
    class: PromoClass;
    conflictDetail: string | null;
  }> = [];

  let alreadyLinkedSame = 0;
  let newPromotable = 0;
  let existingLinkConflict = 0;
  let complexMulti = 0;
  let kaptMulti = 0;

  const usedComplex = new Map<string, string>();
  const usedKapt = new Map<string, string>();

  for (const p of allPairs) {
    const existing = existingByComplex.get(p.master.complexId) ?? null;
    const linkedElsewhere = existingByKapt.get(p.kapt.kaptCode);
    const meta = metaByComplex.get(p.master.complexId) ?? null;
    let cls: PromoClass = "NEW_PROMOTABLE";
    let detail: string | null = null;

    if (existing && existing === p.kapt.kaptCode) {
      cls = "ALREADY_LINKED_SAME";
    } else if (existing && existing !== p.kapt.kaptCode) {
      cls = "EXISTING_LINK_CONFLICT";
      detail = `source_link ${existing} != resolved ${p.kapt.kaptCode}`;
      knownConflicts += 1;
    } else if (linkedElsewhere && linkedElsewhere !== p.master.complexId) {
      cls = "EXISTING_LINK_CONFLICT";
      detail = `KAPT ${p.kapt.kaptCode} already linked to ${linkedElsewhere}`;
      kaptMulti += 1;
    } else if (meta && meta !== p.kapt.kaptCode && !existing) {
      // Carry M2-style meta disagreement as HOLD (do not overwrite)
      cls = "EXISTING_LINK_CONFLICT";
      detail = `profile_meta ${meta} != resolved ${p.kapt.kaptCode}`;
      knownConflicts += 1;
    }

    if (cls === "ALREADY_LINKED_SAME") alreadyLinkedSame += 1;
    else if (cls === "NEW_PROMOTABLE") newPromotable += 1;
    else existingLinkConflict += 1;

    classified.push({ pair: p, class: cls, conflictDetail: detail });
  }

  // Manifest from NEW_PROMOTABLE only; dedupe integrity
  const manifestRows: Array<{
    complexId: string;
    kaptCode: string;
    district: string;
    matchTier: string;
    evidence: string;
    existingLinkState: string;
    resolverVersion: string;
    aptName: string;
    kaptName: string;
  }> = [];

  for (const c of classified) {
    if (c.class !== "NEW_PROMOTABLE") continue;
    const cid = c.pair.master.complexId;
    const kid = c.pair.kapt.kaptCode;
    if (usedComplex.has(cid) || usedKapt.has(kid)) {
      if (usedComplex.has(cid) && usedComplex.get(cid) !== kid) complexMulti += 1;
      if (usedKapt.has(kid) && usedKapt.get(kid) !== cid) kaptMulti += 1;
      continue;
    }
    usedComplex.set(cid, kid);
    usedKapt.set(kid, cid);
    manifestRows.push({
      complexId: cid,
      kaptCode: kid,
      district: c.pair.master.sigungu,
      matchTier: c.pair.tier,
      evidence: c.pair.evidence,
      existingLinkState: "NONE",
      resolverVersion: RESOLVER_VERSION,
      aptName: c.pair.master.aptName,
      kaptName: c.pair.kapt.kaptName,
    });
  }

  const ricentsPair = pairByComplex.get("cx_caf229b5ac63cfbd");
  const ricentsRecovered = ricentsPair?.kapt.kaptCode === "A13822003";

  // M2 conflict forward: any EXISTING_LINK_CONFLICT involving known cases
  const m2ConflictStillHold = existingLinkConflict > 0;

  const safeTotal = totals.EXACT_SAFE + totals.HIGH_CONFIDENCE;
  const safeVsMaster =
    seoulCount === 0 ? 0 : Math.round((safeTotal / seoulCount) * 10000) / 100;
  const safeVsKapt =
    uniqueKapt === 0 ? 0 : Math.round((safeTotal / uniqueKapt) * 10000) / 100;

  const projectedIdReady = currentIdReady + manifestRows.length;
  // Avoid double-count: new promotable should not already be in idReadySet
  const trulyNew = manifestRows.filter((r) => !idReadySet.has(r.complexId));
  const projectedIdReadyAdj = currentIdReady + trulyNew.length;
  const projectedCoverage =
    Math.round((projectedIdReadyAdj / seoulCount) * 10000) / 100;

  // Future management population (projection after promotion)
  let alreadyMgmt = 0;
  let partialRefresh = 0;
  let initialFetch = 0;
  const projectedIds = new Set([
    ...idReadySet,
    ...trulyNew.map((r) => r.complexId),
  ]);
  for (const cid of projectedIds) {
    const u = usableByComplex.get(cid) ?? 0;
    if (u >= 12) alreadyMgmt += 1;
    else if (u > 0) partialRefresh += 1;
    else initialFetch += 1;
  }

  const integrityOk =
    knownWrong === 0 &&
    complexMulti === 0 &&
    kaptMulti === 0 &&
    manifestRows.length === new Set(manifestRows.map((r) => r.complexId)).size &&
    manifestRows.length === new Set(manifestRows.map((r) => r.kaptCode)).size;

  const districtCoverageComplete = completedDistricts.length === 25 && !hit429;
  const manifestReady =
    integrityOk &&
    districtCoverageComplete &&
    manifestRows.length > 0 &&
    knownWrong === 0;

  if (manifestReady) {
    writeFileSync(
      MANIFEST_OUT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          stage: "stage-m3",
          resolverVersion: RESOLVER_VERSION,
          scope: "Seoul 25 sigungu",
          sourceService: "AptListService4/getSigunguAptList4",
          matchTiersIncluded: ["EXACT_SAFE", "HIGH_CONFIDENCE"],
          writePolicy: "manifest_only_no_production_source_link_write",
          expected: {
            newSourceLinks: manifestRows.length,
            inserts: manifestRows.length,
            updates: 0,
            deletes: 0,
          },
          candidates: manifestRows,
        },
        null,
        2,
      ),
    );
  }

  if (ambiguousSamples.length > 0) {
    writeFileSync(
      AMBIGUOUS_OUT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          count: totals.AMBIGUOUS,
          samples: ambiguousSamples.slice(0, 20),
        },
        null,
        2,
      ),
    );
  }

  // Notable districts
  const ranked = Object.entries(districtReports).sort(
    (a, b) => b[1].safeRatePct - a[1].safeRatePct,
  );
  const topDistricts = ranked.slice(0, 3).map(([name, r]) => ({
    name,
    safeRatePct: r.safeRatePct,
    safe: r.EXACT_SAFE + r.HIGH_CONFIDENCE,
    master: r.master,
    kapt: r.kaptDiscovered,
  }));
  const bottomDistricts = ranked
    .slice(-3)
    .reverse()
    .map(([name, r]) => ({
      name,
      safeRatePct: r.safeRatePct,
      safe: r.EXACT_SAFE + r.HIGH_CONFIDENCE,
      master: r.master,
      kapt: r.kaptDiscovered,
    }));

  let nextAction: "A" | "B" | "C" | "D" | "E" = "A";
  let nextReason = "";
  if (hit429 && completedDistricts.length < 25) {
    nextAction = "E";
    nextReason = `429 after ${apiCallsSuccessful} successful calls; ${completedDistricts.length}/25 districts cached.`;
  } else if (knownWrong > 0) {
    nextAction = "B";
    nextReason = "WRONG_MATCH > 0 — resolver must be fixed before promotion.";
  } else if (!districtCoverageComplete) {
    nextAction = "D";
    nextReason = "District coverage incomplete without 429 — repair discovery.";
  } else if (!manifestReady) {
    nextAction = "B";
    nextReason = "Manifest integrity/coverage gate not met — refine resolver.";
  } else if (totals.AMBIGUOUS > 0 && totals.AMBIGUOUS < 50 && safeVsKapt < 40) {
    nextAction = "A";
    nextReason =
      "Full-Seoul discovery PASS; promote safe manifest. Ambiguous remains offline.";
  } else {
    nextAction = "A";
    nextReason =
      "Full-Seoul safe KAPT identity manifest READY for explicit Production source-link promotion.";
  }

  const discovery = {
    generatedAt: new Date().toISOString(),
    stage: "stage-m3-seoul-kapt-identity-discovery",
    resolverVersion: RESOLVER_VERSION,
    resolverChanges: [
      "Preserve M2 EXACT_SAFE (exact name + bjd) and HIGH_CONFIDENCE (name_compatible + bjd)",
      "V2: HIGH_CONFIDENCE suffix_name+bjd+dong when KAPT name ends with master name, as3===legal_dong_name, unique, no competing master (리센츠↔잠실리센츠)",
      "No fuzzy-only matching; no BasisInfo verification crawl",
    ],
    scope: {
      seoulSigungu: 25,
      apartmentMaster: seoulCount,
      districts: districts.map((d) => ({
        name: d.name,
        sigunguCode: d.sigunguCode,
      })),
    },
    api: {
      endpoint: "AptListService4/getSigunguAptList4",
      liveRequestsAttempted: apiCallsAttempted,
      cacheHits,
      successful: apiCallsSuccessful,
      hit429,
      hit429Detail,
      rawRecords,
      uniqueKaptIds: uniqueKapt,
      crossResponseDuplicates: crossDupes,
      recordsPerSuccessfulCall:
        apiCallsSuccessful > 0
          ? Math.round((rawRecords / Math.max(1, apiCallsSuccessful)) * 100) /
            100
          : cacheHits > 0
            ? Math.round((rawRecords / 25) * 100) / 100
            : 0,
      districtCoverage: `${completedDistricts.length}/25`,
      completedDistricts,
      remainingDistricts,
      basisInfoCalls: 0,
      aptIdInfoCalls: 0,
      managementFeeCalls: 0,
      maxBudget: MAX_CALLS,
      cacheDir: CACHE_DIR,
    },
    districts: districtReports,
    notableDistricts: { top: topDistricts, bottom: bottomDistricts },
    totals: {
      EXACT_SAFE: totals.EXACT_SAFE,
      HIGH_CONFIDENCE: totals.HIGH_CONFIDENCE,
      safeTotal,
      AMBIGUOUS: totals.AMBIGUOUS,
      KAPT_ONLY: totals.KAPT_ONLY,
      MASTER_ONLY: totals.MASTER_ONLY,
      safeRateVsMasterPct: safeVsMaster,
      safeRateVsDiscoveredKaptPct: safeVsKapt,
    },
    knownLinkValidation: {
      existingKnownKaptLinks: existingByComplex.size,
      correct: knownCorrect,
      missed: knownMissed,
      wrongMatches: knownWrong,
      conflicts: knownConflicts,
      ricentsRecovered: ricentsRecovered ? "YES" : "NO",
      ricentsResolvedKapt: ricentsPair?.kapt.kaptCode ?? null,
      ricentsEvidence: ricentsPair?.evidence ?? null,
      m2ExistingConflict: m2ConflictStillHold ? "still HOLD" : "resolved",
      missSample: knownMissSample,
      wrongSample: knownWrongSample,
    },
    identityIntegrity: {
      complexToMultipleKapt: complexMulti,
      kaptToMultipleComplex: kaptMulti,
      duplicateManifestComplex: 0,
      duplicateManifestKapt: 0,
      slugIdentities: 0,
      wrongKnownMatches: knownWrong,
    },
    promotionPopulation: {
      ALREADY_LINKED_SAME: alreadyLinkedSame,
      NEW_PROMOTABLE: trulyNew.length,
      EXISTING_LINK_CONFLICT: existingLinkConflict,
      manifestRows: manifestRows.length,
    },
    projectedIdentityCoverage: {
      currentIdReady,
      newPromotable: trulyNew.length,
      projectedIdReady: projectedIdReadyAdj,
      apartmentMasterIdentityCoveragePct: projectedCoverage,
      discoveredKaptSafeResolutionRatePct: safeVsKapt,
    },
    futureManagementPopulation: {
      alreadyManagementCovered: alreadyMgmt,
      partialRefreshCandidates: partialRefresh,
      initialManagementFetchCandidates: initialFetch,
      note: "Projection after promoting M3 safe source links; no management API calls.",
    },
    ambiguous: {
      count: totals.AMBIGUOUS,
      representativeArtifact: ambiguousSamples.length > 0,
      path:
        ambiguousSamples.length > 0
          ? "data/poc/management/stage-m3-kapt-ambiguous-samples.json"
          : null,
    },
    dbWrites: {
      sourceLinkInsert: 0,
      update: 0,
      delete: 0,
      managementWrites: 0,
      otherBusinessWrites: 0,
    },
    manifest: {
      created: manifestReady,
      path: manifestReady
        ? "data/poc/management/stage-m3-seoul-kapt-identity-promotion-manifest.json"
        : null,
      rows: manifestReady ? manifestRows.length : 0,
    },
    nextAction: {
      choice: nextAction,
      reason: nextReason,
    },
    decision: {
      FULL_SEOUL_KAPT_DISCOVERY: districtCoverageComplete
        ? "PASS"
        : hit429
          ? "PARTIAL"
          : "HOLD",
      KNOWN_LINK_RECOVERY:
        knownWrong === 0
          ? knownMissed === 0
            ? "PASS"
            : "PARTIAL"
          : "HOLD",
      RESOLVER_SAFETY: knownWrong === 0 ? "PASS" : "HOLD",
      RESOLVER_COVERAGE:
        safeVsKapt >= 40 ? "PASS" : safeVsKapt >= 25 ? "PARTIAL" : "HOLD",
      PROMOTION_MANIFEST: manifestReady ? "READY" : "NOT_READY",
      MANAGEMENT_FEE_FETCH: "NOT_STARTED",
      DATA_SAFETY: "PASS",
    },
  };

  writeFileSync(DISCOVERY_OUT, JSON.stringify(discovery, null, 2));

  console.log(
    JSON.stringify(
      {
        out: DISCOVERY_OUT,
        manifestCreated: manifestReady,
        manifestRows: manifestReady ? manifestRows.length : 0,
        api: discovery.api,
        totals: discovery.totals,
        knownLinkValidation: discovery.knownLinkValidation,
        promotionPopulation: discovery.promotionPopulation,
        projectedIdentityCoverage: discovery.projectedIdentityCoverage,
        futureManagementPopulation: discovery.futureManagementPopulation,
        nextAction: discovery.nextAction,
        decision: discovery.decision,
        notableDistricts: discovery.notableDistricts,
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
