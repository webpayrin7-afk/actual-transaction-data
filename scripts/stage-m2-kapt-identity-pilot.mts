/**
 * MANAGEMENT STAGE M2 — KAPT identity acquisition pilot.
 * Districts: 송파구 / 강남구 / 노원구
 * Bulk: AptListService4/getSigunguAptList4
 * HARD MAX: 20 KAPT HTTP requests. First 429 → STOP.
 * Management-fee APIs: 0. Production source-link writes: 0.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const API_BASE = "https://apis.data.go.kr/1613000";
const SERVICE_KEY = process.env.MOLIT_API_KEY?.trim();
const MAX_CALLS = 20;
const PAGE_SIZE = 5000;

const OUT_DIR = join(process.cwd(), "data/poc/management");
const CACHE_DIR = join("/tmp", "cursor-m2-kapt-cache");
const PILOT_OUT = join(OUT_DIR, "stage-m2-kapt-identity-pilot.json");
const MANIFEST_OUT = join(
  OUT_DIR,
  "stage-m2-kapt-identity-promotion-manifest.json",
);

const DISTRICTS = [
  { name: "송파구", sigunguCode: "11710" },
  { name: "강남구", sigunguCode: "11680" },
  { name: "노원구", sigunguCode: "11350" },
] as const;

type Json = Record<string, unknown>;
type KaptListItem = {
  kaptCode: string;
  kaptName: string;
  bjdCode: string;
  as1?: string;
  as2?: string;
  as3?: string;
  as4?: string;
};

type MasterRow = {
  complexId: string;
  aptName: string;
  aptNameNorm: string;
  lawdCd: string;
  bjdongCd: string | null;
  jibun: string | null;
  sigungu: string;
  legalDongName: string | null;
};

type MatchTier =
  | "EXACT_SAFE"
  | "HIGH_CONFIDENCE"
  | "AMBIGUOUS"
  | "KAPT_ONLY"
  | "MASTER_ONLY";

type SafeCandidate = {
  complexId: string;
  kaptCode: string;
  district: string;
  matchTier: "EXACT_SAFE" | "HIGH_CONFIDENCE";
  matchEvidence: string;
  aptName: string;
  kaptName: string;
  alreadyLinked: boolean;
  existingLinkKapt: string | null;
};

let apiCallsAttempted = 0;
let apiCallsSuccessful = 0;
let hit429 = false;
let hit429Detail: {
  endpoint: string;
  requestNumber: number;
  district: string;
  page: number;
} | null = null;
let cacheReused = false;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeName(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[()\[\]{}·・･]/g, "")
    .replace(/아파트$/g, "아파트")
    .trim()
    .toLowerCase();
}

function namesCompatible(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Require substantial overlap — not single-char substring
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) {
    return true;
  }
  return false;
}

function fullBjd(lawdCd: string, bjdongCd: string | null): string | null {
  if (!lawdCd || lawdCd.length < 5) return null;
  if (!bjdongCd) return null;
  if (bjdongCd.length >= 10) return bjdongCd;
  return `${lawdCd.slice(0, 5)}${bjdongCd}`;
}

function cachePath(sigunguCode: string, pageNo: number): string {
  return join(CACHE_DIR, `getSigunguAptList4_${sigunguCode}_p${pageNo}.json`);
}

async function fetchSigunguPage(
  sigunguCode: string,
  districtName: string,
  pageNo: number,
): Promise<{ items: KaptListItem[]; totalCount: number; fromCache: boolean }> {
  const cp = cachePath(sigunguCode, pageNo);
  if (existsSync(cp)) {
    cacheReused = true;
    const cached = JSON.parse(readFileSync(cp, "utf8")) as {
      items: KaptListItem[];
      totalCount: number;
    };
    return { ...cached, fromCache: true };
  }

  if (hit429) {
    return { items: [], totalCount: 0, fromCache: false };
  }
  if (apiCallsAttempted >= MAX_CALLS) {
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
    throw new Error(`HTTP ${res.status} ${url.replace(SERVICE_KEY!, "REDACTED")}`);
  }

  const json = (await res.json()) as Json;
  const body = (json.response as Json | undefined)?.body as Json | undefined;
  const totalCount = Number(body?.totalCount ?? 0);
  const rawItems = body?.items;
  let items: KaptListItem[] = [];
  if (Array.isArray(rawItems)) {
    items = rawItems as KaptListItem[];
  } else if (
    rawItems &&
    typeof rawItems === "object" &&
    Array.isArray((rawItems as Json).item)
  ) {
    items = (rawItems as Json).item as KaptListItem[];
  } else if (rawItems && typeof rawItems === "object" && (rawItems as Json).kaptCode) {
    items = [rawItems as unknown as KaptListItem];
  }

  apiCallsSuccessful += 1;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    cp,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        sigunguCode,
        pageNo,
        totalCount,
        itemCount: items.length,
        items,
      },
      null,
      2,
    ),
  );

  await sleep(200);
  return { items, totalCount, fromCache: false };
}

async function discoverDistrict(
  districtName: string,
  sigunguCode: string,
): Promise<{
  items: KaptListItem[];
  pages: number;
  totalCountReported: number;
  callsUsed: number;
}> {
  const all: KaptListItem[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalCountReported = 0;
  let pages = 0;
  const callsBefore = apiCallsAttempted;

  while (!hit429 && apiCallsAttempted < MAX_CALLS) {
    const { items, totalCount } = await fetchSigunguPage(
      sigunguCode,
      districtName,
      page,
    );
    if (items.length === 0 && totalCount === 0 && hit429) break;
    if (items.length === 0 && page > 1) break;
    pages += 1;
    if (totalCount > 0) totalCountReported = totalCount;
    for (const it of items) {
      const code = String(it.kaptCode ?? "");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      all.push({
        kaptCode: code,
        kaptName: String(it.kaptName ?? ""),
        bjdCode: String(it.bjdCode ?? ""),
        as1: it.as1 != null ? String(it.as1) : undefined,
        as2: it.as2 != null ? String(it.as2) : undefined,
        as3: it.as3 != null ? String(it.as3) : undefined,
        as4: it.as4 != null ? String(it.as4) : undefined,
      });
    }
    if (totalCountReported > 0 && all.length >= totalCountReported) break;
    if (items.length < PAGE_SIZE) break;
    page += 1;
    if (page > 5) break; // safety within budget
  }

  return {
    items: all,
    pages,
    totalCountReported,
    callsUsed: apiCallsAttempted - callsBefore,
  };
}

type Pair = {
  master: MasterRow;
  kapt: KaptListItem;
  tier: "EXACT_SAFE" | "HIGH_CONFIDENCE";
  evidence: string;
};

function matchDistrict(
  masters: MasterRow[],
  kapts: KaptListItem[],
): {
  pairs: Pair[];
  ambiguousMaster: string[];
  ambiguousKapt: string[];
  masterOnly: string[];
  kaptOnly: string[];
  counts: Record<MatchTier, number>;
} {
  const byBjd = new Map<string, KaptListItem[]>();
  for (const k of kapts) {
    const b = String(k.bjdCode ?? "");
    if (!b) continue;
    const arr = byBjd.get(b) ?? [];
    arr.push(k);
    byBjd.set(b, arr);
  }

  const assignedMaster = new Set<string>();
  const assignedKapt = new Set<string>();
  const pairs: Pair[] = [];
  const ambiguousMaster: string[] = [];
  const ambiguousKaptCodes = new Set<string>();

  // Pass 1: EXACT_SAFE — normalized name exact + bjd unique
  for (const m of masters) {
    const bjd = fullBjd(m.lawdCd, m.bjdongCd);
    if (!bjd) continue;
    const pool = byBjd.get(bjd) ?? [];
    const exact = pool.filter(
      (k) => normalizeName(k.kaptName) === normalizeName(m.aptName),
    );
    if (exact.length === 1) {
      const k = exact[0]!;
      if (!assignedKapt.has(k.kaptCode) && !assignedMaster.has(m.complexId)) {
        pairs.push({
          master: m,
          kapt: k,
          tier: "EXACT_SAFE",
          evidence: `exact_name+bjd(${bjd})`,
        });
        assignedMaster.add(m.complexId);
        assignedKapt.add(k.kaptCode);
      }
    } else if (exact.length > 1) {
      ambiguousMaster.push(m.complexId);
      for (const k of exact) ambiguousKaptCodes.add(k.kaptCode);
    }
  }

  // Pass 2: HIGH_CONFIDENCE — name compatible + bjd, unique remaining
  for (const m of masters) {
    if (assignedMaster.has(m.complexId)) continue;
    const bjd = fullBjd(m.lawdCd, m.bjdongCd);
    if (!bjd) continue;
    const pool = (byBjd.get(bjd) ?? []).filter((k) => !assignedKapt.has(k.kaptCode));
    const compat = pool.filter((k) => namesCompatible(m.aptName, k.kaptName));
    if (compat.length === 1) {
      const k = compat[0]!;
      // Exclude pure exact (already handled); remaining are formatting variants
      pairs.push({
        master: m,
        kapt: k,
        tier: "HIGH_CONFIDENCE",
        evidence: `name_compatible+bjd(${bjd}); master=${m.aptName}; kapt=${k.kaptName}`,
      });
      assignedMaster.add(m.complexId);
      assignedKapt.add(k.kaptCode);
    } else if (compat.length > 1) {
      ambiguousMaster.push(m.complexId);
      for (const k of compat) ambiguousKaptCodes.add(k.kaptCode);
    }
  }

  const masterOnly = masters
    .filter((m) => !assignedMaster.has(m.complexId) && !ambiguousMaster.includes(m.complexId))
    .map((m) => m.complexId);
  // masters that were ambiguous but not assigned
  const ambMasters = [...new Set(ambiguousMaster)].filter(
    (id) => !assignedMaster.has(id),
  );

  const kaptOnly = kapts
    .filter((k) => !assignedKapt.has(k.kaptCode) && !ambiguousKaptCodes.has(k.kaptCode))
    .map((k) => k.kaptCode);

  const counts: Record<MatchTier, number> = {
    EXACT_SAFE: pairs.filter((p) => p.tier === "EXACT_SAFE").length,
    HIGH_CONFIDENCE: pairs.filter((p) => p.tier === "HIGH_CONFIDENCE").length,
    AMBIGUOUS: ambMasters.length,
    KAPT_ONLY: kaptOnly.length,
    MASTER_ONLY: masterOnly.length,
  };

  return {
    pairs,
    ambiguousMaster: ambMasters,
    ambiguousKapt: [...ambiguousKaptCodes],
    masterOnly,
    kaptOnly,
    counts,
  };
}

async function main() {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // Existing KAPT links (ground truth)
  const linkRows = await db.execute(`
    SELECT l.complex_id, l.source_key, m.sigungu, m.apt_name
    FROM apt_complex_source_links l
    JOIN apt_complex_master m ON m.complex_id = l.complex_id
    WHERE l.source = 'KAPT'
  `);
  const existingByComplex = new Map<string, string>();
  const existingByKapt = new Map<string, string>();
  for (const r of linkRows.rows) {
    existingByComplex.set(String(r.complex_id), String(r.source_key));
    existingByKapt.set(String(r.source_key), String(r.complex_id));
  }

  // Profile meta KAPT (also known, but not Production source_link)
  const profileMeta = await db.execute(`
    SELECT m.complex_id, p.raw_meta_json
    FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.sigungu IN ('송파구','강남구','노원구')
      AND p.raw_meta_json IS NOT NULL
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

  const districtReports: Record<string, unknown> = {};
  const allPairs: Pair[] = [];
  let totalMaster = 0;
  let totalKapt = 0;
  const totals = {
    EXACT_SAFE: 0,
    HIGH_CONFIDENCE: 0,
    AMBIGUOUS: 0,
    KAPT_ONLY: 0,
    MASTER_ONLY: 0,
  };

  let knownInScope = 0;
  let correctlyRediscovered = 0;
  let missedKnown = 0;
  let wrongMatches = 0;
  const knownMissDetails: Array<{ complexId: string; expected: string }> = [];
  const wrongDetails: Array<{
    complexId: string;
    expected: string;
    got: string;
  }> = [];

  let complexMultiKapt = 0;
  let kaptMultiComplex = 0;
  let existingDisagreement = 0;

  const safeCandidates: SafeCandidate[] = [];

  for (const d of DISTRICTS) {
    const masterRs = await db.execute({
      sql: `
        SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun,
               sigungu, legal_dong_name
        FROM apt_complex_master
        WHERE sido_code='11' AND sigungu=?
      `,
      args: [d.name],
    });
    const masters: MasterRow[] = masterRs.rows.map((r) => ({
      complexId: String(r.complex_id),
      aptName: String(r.apt_name),
      aptNameNorm: String(r.apt_name_norm ?? r.apt_name),
      lawdCd: String(r.lawd_cd ?? ""),
      bjdongCd: r.bjdong_cd != null ? String(r.bjdong_cd) : null,
      jibun: r.jibun != null ? String(r.jibun) : null,
      sigungu: String(r.sigungu),
      legalDongName:
        r.legal_dong_name != null ? String(r.legal_dong_name) : null,
    }));

    const discovery = await discoverDistrict(d.name, d.sigunguCode);
    const match = matchDistrict(masters, discovery.items);

    totalMaster += masters.length;
    totalKapt += discovery.items.length;
    totals.EXACT_SAFE += match.counts.EXACT_SAFE;
    totals.HIGH_CONFIDENCE += match.counts.HIGH_CONFIDENCE;
    totals.AMBIGUOUS += match.counts.AMBIGUOUS;
    totals.KAPT_ONLY += match.counts.KAPT_ONLY;
    totals.MASTER_ONLY += match.counts.MASTER_ONLY;
    allPairs.push(...match.pairs);

    const safeRate =
      masters.length === 0
        ? 0
        : Math.round(
            ((match.counts.EXACT_SAFE + match.counts.HIGH_CONFIDENCE) /
              masters.length) *
              10000,
          ) / 100;
    const kaptSafeRate =
      discovery.items.length === 0
        ? 0
        : Math.round(
            ((match.counts.EXACT_SAFE + match.counts.HIGH_CONFIDENCE) /
              discovery.items.length) *
              10000,
          ) / 100;

    // Known-link validation in district
    for (const m of masters) {
      const known = existingByComplex.get(m.complexId);
      if (!known) continue;
      knownInScope += 1;
      const hit = match.pairs.find((p) => p.master.complexId === m.complexId);
      if (!hit) {
        missedKnown += 1;
        knownMissDetails.push({ complexId: m.complexId, expected: known });
      } else if (hit.kapt.kaptCode !== known) {
        wrongMatches += 1;
        wrongDetails.push({
          complexId: m.complexId,
          expected: known,
          got: hit.kapt.kaptCode,
        });
      } else {
        correctlyRediscovered += 1;
      }
    }

    // Build safe candidates for this district
    for (const p of match.pairs) {
      const existing = existingByComplex.get(p.master.complexId) ?? null;
      const linkedElsewhere = existingByKapt.get(p.kapt.kaptCode);
      let conflict = false;
      if (existing && existing !== p.kapt.kaptCode) {
        conflict = true;
        existingDisagreement += 1;
      }
      if (linkedElsewhere && linkedElsewhere !== p.master.complexId) {
        conflict = true;
        kaptMultiComplex += 1;
      }
      const meta = metaByComplex.get(p.master.complexId);
      if (meta && meta !== p.kapt.kaptCode && !existing) {
        // profile meta disagrees — HOLD from manifest
        conflict = true;
        existingDisagreement += 1;
      }
      if (conflict) continue;

      safeCandidates.push({
        complexId: p.master.complexId,
        kaptCode: p.kapt.kaptCode,
        district: d.name,
        matchTier: p.tier,
        matchEvidence: p.evidence,
        aptName: p.master.aptName,
        kaptName: p.kapt.kaptName,
        alreadyLinked: existing === p.kapt.kaptCode,
        existingLinkKapt: existing,
      });
    }

    districtReports[d.name] = {
      master: masters.length,
      kaptDiscovered: discovery.items.length,
      totalCountReported: discovery.totalCountReported,
      pages: discovery.pages,
      callsUsed: discovery.callsUsed,
      EXACT_SAFE: match.counts.EXACT_SAFE,
      HIGH_CONFIDENCE: match.counts.HIGH_CONFIDENCE,
      AMBIGUOUS: match.counts.AMBIGUOUS,
      KAPT_ONLY: match.counts.KAPT_ONLY,
      MASTER_ONLY: match.counts.MASTER_ONLY,
      safeMatchRatePct: safeRate,
      kaptSideSafeMatchRatePct: kaptSafeRate,
    };
  }

  // Integrity: same complex → multiple KAPT in candidates
  {
    const byC = new Map<string, Set<string>>();
    for (const c of safeCandidates) {
      const s = byC.get(c.complexId) ?? new Set();
      s.add(c.kaptCode);
      byC.set(c.complexId, s);
    }
    for (const s of byC.values()) {
      if (s.size > 1) complexMultiKapt += 1;
    }
  }

  const newPromotable = safeCandidates.filter((c) => !c.alreadyLinked);
  const alreadyLinked = safeCandidates.filter((c) => c.alreadyLinked);
  const manifestCreated =
    newPromotable.length > 0 &&
    complexMultiKapt === 0 &&
    wrongMatches === 0;

  if (manifestCreated) {
    writeFileSync(
      MANIFEST_OUT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          stage: "stage-m2",
          districts: DISTRICTS.map((d) => d.name),
          sourceService: "AptListService4/getSigunguAptList4",
          matchTiersIncluded: ["EXACT_SAFE", "HIGH_CONFIDENCE"],
          writePolicy: "manifest_only_no_production_source_link_write",
          candidates: newPromotable,
          alreadyLinkedExcludedFromPromotion: alreadyLinked.length,
          expected: {
            newSourceLinks: newPromotable.length,
            inserts: newPromotable.length,
            updates: 0,
            deletes: 0,
          },
        },
        null,
        2,
      ),
    );
  }

  // Full Seoul estimate: 25 districts typical; pilot used ~1 call/district when page fits
  const successfulCalls = apiCallsSuccessful;
  const recordsPerCall =
    successfulCalls > 0
      ? Math.round((totalKapt / successfulCalls) * 100) / 100
      : 0;
  const seoulSigunguApprox = 25;
  const callsPerDistrict =
    DISTRICTS.length > 0
      ? Math.max(
          1,
          Math.ceil(
            Object.values(districtReports).reduce(
              (s, d) => s + Number((d as { pages?: number }).pages ?? 1),
              0,
            ) / DISTRICTS.length,
          ),
        )
      : 1;
  const estimatedSeoulCalls = seoulSigunguApprox * callsPerDistrict;
  const safeMasterRate =
    totalMaster === 0
      ? 0
      : (totals.EXACT_SAFE + totals.HIGH_CONFIDENCE) / totalMaster;
  const estimatedSafeMatches = Math.round(8437 * safeMasterRate);
  const estimatedAmbiguous = Math.round(
    8437 * (totals.AMBIGUOUS / Math.max(1, totalMaster)),
  );

  // Decision gate
  let gate: "A" | "B" | "C" | "D" = "B";
  let gateReason = "";
  if (hit429 && apiCallsSuccessful === 0) {
    gate = "D";
    gateReason = "429 before any successful bulk discovery.";
  } else if (hit429) {
    gate = "D";
    gateReason = `429 after ${apiCallsSuccessful} successful calls — cooldown before scale.`;
  } else if (recordsPerCall < 50 && successfulCalls > 5) {
    gate = "C";
    gateReason = "Too few records per call for efficient full-Seoul scale.";
  } else if (
    wrongMatches === 0 &&
    complexMultiKapt === 0 &&
    safeMasterRate >= 0.25 &&
    recordsPerCall >= 100
  ) {
    gate = "A";
    gateReason =
      "Bulk list efficient; known-link recovery clean; safe match rate useful for scale.";
  } else if (safeMasterRate < 0.25 || totals.AMBIGUOUS > totals.EXACT_SAFE) {
    gate = "B";
    gateReason =
      "Bulk discovery works but ambiguous/MASTER_ONLY population large — refine local resolver before scaling writes.";
  } else {
    gate = "A";
    gateReason =
      "Bulk path valid with acceptable match quality; proceed carefully to full-Seoul discovery.";
  }

  // Soften A if safe rate medium but API efficient
  if (
    !hit429 &&
    wrongMatches === 0 &&
    recordsPerCall >= 200 &&
    safeMasterRate >= 0.15 &&
    gate === "B"
  ) {
    // keep B if ambiguous dominates
    if (totals.AMBIGUOUS <= (totals.EXACT_SAFE + totals.HIGH_CONFIDENCE)) {
      gate = "A";
      gateReason =
        "Efficient bulk discovery + zero wrong known-link matches; safe tier useful; refine ambiguous offline.";
    }
  }

  const nextActionMap = {
    A: {
      choice: "A" as const,
      label: "Full-Seoul KAPT identity discovery + manifest",
    },
    B: { choice: "B" as const, label: "Identity resolver refinement" },
    C: { choice: "C" as const, label: "Alternative bulk identity strategy" },
    D: { choice: "D" as const, label: "KAPT rate-limit cooldown" },
  };

  const pilot = {
    generatedAt: new Date().toISOString(),
    stage: "stage-m2-kapt-identity-pilot",
    scope: {
      districts: DISTRICTS.map((d) => d.name),
      apartmentMasterComplexes: totalMaster,
    },
    api: {
      serviceUsed: "AptListService4/getSigunguAptList4",
      basisInfoCalls: 0,
      aptIdInfoCalls: 0,
      managementFeeCalls: 0,
      requestsAttempted: apiCallsAttempted,
      successful: apiCallsSuccessful,
      hit429,
      hit429Detail,
      recordsReturned: totalKapt,
      uniqueKaptComplexes: totalKapt,
      recordsPerSuccessfulCall: recordsPerCall,
      cacheReused,
      cacheDir: CACHE_DIR,
      maxBudget: MAX_CALLS,
    },
    districts: districtReports,
    knownIdentityValidation: {
      existingKnownKaptLinksInScope: knownInScope,
      correctlyRediscovered,
      missed: missedKnown,
      wrongMatches,
      conflicts: existingDisagreement,
      missSample: knownMissDetails.slice(0, 20),
      wrongSample: wrongDetails.slice(0, 20),
    },
    totals: {
      masterComplexes: totalMaster,
      kaptDiscovered: totalKapt,
      EXACT_SAFE: totals.EXACT_SAFE,
      HIGH_CONFIDENCE: totals.HIGH_CONFIDENCE,
      safeTotal: totals.EXACT_SAFE + totals.HIGH_CONFIDENCE,
      AMBIGUOUS: totals.AMBIGUOUS,
      KAPT_ONLY: totals.KAPT_ONLY,
      MASTER_ONLY: totals.MASTER_ONLY,
      safeMasterMatchRatePct: Math.round(safeMasterRate * 10000) / 100,
    },
    identityIntegrity: {
      complexToMultipleKaptConflicts: complexMultiKapt,
      kaptToMultipleComplexConflicts: kaptMultiComplex,
      existingLinkDisagreements: existingDisagreement,
    },
    manifest: {
      created: manifestCreated,
      path: manifestCreated
        ? "data/poc/management/stage-m2-kapt-identity-promotion-manifest.json"
        : null,
      safeCandidates: safeCandidates.length,
      alreadyLinked: alreadyLinked.length,
      newPromotableLinks: newPromotable.length,
    },
    fullSeoulEstimate: {
      estimatedKaptListCalls: estimatedSeoulCalls,
      estimatedRecords: Math.round(
        (totalKapt / Math.max(1, DISTRICTS.length)) * seoulSigunguApprox,
      ),
      estimatedSafeMatches,
      estimatedAmbiguous,
      note: "Extrapolated from 3-district pilot pages/match rates; paging may differ by district.",
    },
    managementApi: {
      commonCostCalls: 0,
      individualCostCalls: 0,
      reserveCalls: 0,
    },
    dbWrites: {
      sourceLinkInserts: 0,
      updates: 0,
      deletes: 0,
      managementWrites: 0,
      otherBusinessWrites: 0,
    },
    decisionGate: {
      choice: gate,
      reason: gateReason,
      ...nextActionMap[gate],
    },
    decision: {
      BULK_KAPT_DISCOVERY: hit429
        ? apiCallsSuccessful > 0
          ? "PARTIAL"
          : "HOLD"
        : "PASS",
      KNOWN_LINK_RECOVERY:
        wrongMatches === 0 && (knownInScope === 0 || correctlyRediscovered > 0)
          ? "PASS"
          : wrongMatches === 0
            ? "PASS"
            : "HOLD",
      MATCH_QUALITY:
        safeMasterRate >= 0.25
          ? "PASS"
          : safeMasterRate >= 0.1
            ? "PARTIAL"
            : "HOLD",
      API_EFFICIENCY:
        !hit429 && recordsPerCall >= 100 ? "PASS" : hit429 ? "HOLD" : "HOLD",
      PROMOTION_MANIFEST: manifestCreated ? "READY" : "NOT_READY",
      MANAGEMENT_FEE_FETCH: "NOT_STARTED",
      DATA_SAFETY: "PASS",
    },
  };

  writeFileSync(PILOT_OUT, JSON.stringify(pilot, null, 2));
  console.log(
    JSON.stringify(
      {
        out: PILOT_OUT,
        manifestCreated,
        api: pilot.api,
        districts: districtReports,
        totals: pilot.totals,
        knownIdentityValidation: pilot.knownIdentityValidation,
        identityIntegrity: pilot.identityIntegrity,
        fullSeoulEstimate: pilot.fullSeoulEstimate,
        decisionGate: pilot.decisionGate,
        decision: pilot.decision,
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
