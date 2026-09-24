/**
 * Same-row PNU repair dry-run report. No Production writes.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { haversineMeters } from "../../src/lib/complex-detail/geo";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";
import {
  classifySameRowRepair,
  isSafeRepairClass,
  type ParcelLookupStatus,
  type SameRowRepairClass,
} from "../../src/lib/complex-coordinates/same-row-pnu-repair";
import { quantile } from "../../src/lib/complex-coordinates/parcel-point-join";
import type { IndexedParcel } from "../../src/lib/complex-coordinates/parcel-point-join";

const JAMSIL_PARCEL = { lat: 37.51413457, lng: 127.07932524 };
const JAMSIL_PNU = "1171010100100190000";

export type RepairSourceRow = {
  complex_id: string;
  apt_name: string;
  sigungu: string | null;
  legal_dong: string | null;
  identity_status: string;
  full_pnus: string[];
  addresses: string[];
  spatial_status: string;
  lot_agrees: boolean | null;
};

function round1(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function lookupStatus(
  index: Map<string, IndexedParcel>,
  validPoint: (lat: number, lng: number) => boolean,
): (pnu: string) => ParcelLookupStatus {
  return (pnu) => {
    const hit = index.get(pnu);
    if (!hit) return "MISSING";
    if (hit.status === "DUPLICATE_CONFLICT") return "DUPLICATE";
    if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lng) || !validPoint(hit.lat, hit.lng)) {
      return "INVALID_COORD";
    }
    return "UNIQUE_VALID";
  };
}

function pointOf(index: Map<string, IndexedParcel>, pnu: string | null): { lat: number; lng: number } | null {
  if (!pnu) return null;
  const hit = index.get(pnu);
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lng)) return null;
  return { lat: hit.lat, lng: hit.lng };
}

export function writeSameRowRepairReport(opts: {
  outDir: string;
  rows: RepairSourceRow[];
  index: Map<string, IndexedParcel>;
  validPoint: (lat: number, lng: number) => boolean;
}): { decision: string; safe: number; sampleGate: string; jamsil: string } {
  const lookup = lookupStatus(opts.index, opts.validPoint);
  const decided = opts.rows.map((row) => {
    const decision = classifySameRowRepair(row.full_pnus, row.addresses, lookup);
    const usePnu = isSafeRepairClass(decision.classification) ? decision.derivedPnu : null;
    const point = pointOf(opts.index, usePnu);
    return { row, decision, point };
  });

  const counts: Record<string, number> = {};
  const causes: Record<string, number> = {};
  for (const item of decided) {
    counts[item.decision.classification] = (counts[item.decision.classification] || 0) + 1;
    if (
      item.decision.cause &&
      (item.decision.classification === "REPAIRED_FROM_SAME_ROW_LOT" ||
        item.decision.classification === "ORIGINAL_CONFLICT_REPAIRED")
    ) {
      causes[item.decision.cause] = (causes[item.decision.cause] || 0) + 1;
    }
  }

  const byName = (name: string) => decided.find((item) => item.row.apt_name === name);
  const take = (pred: (item: (typeof decided)[number]) => boolean, n: number, seen: Set<string>) => {
    const out = [];
    for (const item of decided) {
      if (out.length >= n) break;
      if (seen.has(item.row.complex_id) || !pred(item)) continue;
      seen.add(item.row.complex_id);
      out.push(item);
    }
    return out;
  };
  const seen = new Set<string>();
  const named = [byName("선우쉐르빌"), byName("서초지웰")].filter((item): item is NonNullable<typeof item> => Boolean(item));
  for (const item of named) seen.add(item.row.complex_id);
  const samples = [
    ...named,
    ...take((item) => item.row.spatial_status === "PNU_NOT_FOUND", 15, seen),
    ...take((item) => item.row.spatial_status === "EXACT_PNU" && item.row.lot_agrees === false, 15, seen),
    ...take((item) => item.row.identity_status === "NO_PNU", 10, seen),
  ];

  const sampleView = samples.map((item) => ({
    complex_id: item.row.complex_id,
    apt_name: item.row.apt_name,
    reb_stored_pnu: item.decision.storedPnu,
    same_row_address: item.decision.rawAddress,
    derived_pnu: item.decision.derivedPnu,
    derived_cadastral_hit: item.decision.derivedPnu ? lookup(item.decision.derivedPnu) === "UNIQUE_VALID" : false,
    parcel_coordinate: item.point,
    classification: item.decision.classification,
    cause: item.decision.cause,
  }));

  const namedOk = named.length === 2 && named.every((item) =>
    (item.decision.classification === "REPAIRED_FROM_SAME_ROW_LOT" ||
      item.decision.classification === "ORIGINAL_CONFLICT_REPAIRED") &&
    item.point != null &&
    opts.validPoint(item.point.lat, item.point.lng),
  );
  const repairedSamplesOk = sampleView
    .filter((sample) => sample.classification === "REPAIRED_FROM_SAME_ROW_LOT" || sample.classification === "ORIGINAL_CONFLICT_REPAIRED")
    .every((sample) => sample.derived_cadastral_hit && sample.parcel_coordinate && sample.derived_pnu?.length === 19);

  const jam = decided.find((item) => item.row.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId);
  const jamPoint = jam?.point;
  const jamsilPass = Boolean(
    jam &&
      jam.decision.classification === "EXACT_ORIGINAL" &&
      jam.decision.derivedPnu === JAMSIL_PNU &&
      jamPoint &&
      Math.abs(jamPoint.lat - JAMSIL_PARCEL.lat) < 1e-7 &&
      Math.abs(jamPoint.lng - JAMSIL_PARCEL.lng) < 1e-7,
  );
  const sampleGate = namedOk && repairedSamplesOk && jamsilPass ? "PASS" : "FAIL";

  const safeItems = decided.filter((item) => isSafeRepairClass(item.decision.classification) && item.point);
  const byPnu = new Map<string, string[]>();
  for (const item of safeItems) {
    const pnu = item.decision.derivedPnu;
    if (!pnu) continue;
    const list = byPnu.get(pnu) || [];
    list.push(item.row.complex_id);
    byPnu.set(pnu, list);
  }
  const groups = [...byPnu.entries()].filter(([, ids]) => ids.length > 1);
  groups.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const gu = new Map<string, { n: number; repair: number }>();
  const dong = new Map<string, { n: number; repair: number }>();
  for (const item of decided) {
    const repaired =
      item.decision.classification === "REPAIRED_FROM_SAME_ROW_LOT" ||
      item.decision.classification === "ORIGINAL_CONFLICT_REPAIRED";
    const g = item.row.sigungu || "(none)";
    const d = `${item.row.sigungu || ""} ${item.row.legal_dong || ""}`.trim() || "(none)";
    const gb = gu.get(g) || { n: 0, repair: 0 };
    gb.n += 1;
    if (repaired) gb.repair += 1;
    gu.set(g, gb);
    const db = dong.get(d) || { n: 0, repair: 0 };
    db.n += 1;
    if (repaired) db.repair += 1;
    dong.set(d, db);
  }
  const guPatterns = [...gu.entries()]
    .filter(([, v]) => v.n >= 30 && v.repair / v.n >= 0.5)
    .sort((a, b) => b[1].repair / b[1].n - a[1].repair / a[1].n)
    .slice(0, 8)
    .map(([name, v]) => ({ name, complexes: v.n, repaired: v.repair, rate: Number((v.repair / v.n).toFixed(3)) }));
  const dongPatterns = [...dong.entries()]
    .filter(([, v]) => v.n >= 15)
    .sort((a, b) => b[1].repair - a[1].repair)
    .slice(0, 8)
    .map(([name, v]) => ({ name, complexes: v.n, repaired: v.repair, rate: Number((v.repair / v.n).toFixed(3)) }));

  const knownPath = join(opts.outDir, "coordinate-source-gate-overrides.json");
  const distances: number[] = [];
  const bands = { le50: 0, m50_100: 0, m100_250: 0, m250_500: 0, m500: 0 };
  const repairedBands = { ...bands };
  const disagreements: Array<Record<string, unknown>> = [];
  let compared = 0;
  let repairedCompared = 0;
  if (existsSync(knownPath)) {
    const known = JSON.parse(readFileSync(knownPath, "utf8")) as {
      overrides?: Record<string, { lat: number; lng: number; source?: string; method?: string }>;
    };
    const byId = new Map(decided.map((item) => [item.row.complex_id, item]));
    for (const [id, coord] of Object.entries(known.overrides || {})) {
      const item = byId.get(id);
      if (!item?.point || !isSafeRepairClass(item.decision.classification)) continue;
      compared += 1;
      const d = haversineMeters(item.point.lat, item.point.lng, coord.lat, coord.lng);
      distances.push(d);
      const bucket = d <= 50 ? "le50" : d <= 100 ? "m50_100" : d <= 250 ? "m100_250" : d <= 500 ? "m250_500" : "m500";
      bands[bucket] += 1;
      const repaired = item.decision.classification !== "EXACT_ORIGINAL";
      if (repaired) {
        repairedCompared += 1;
        repairedBands[bucket] += 1;
      }
      if (d > 500) {
        disagreements.push({
          complex_id: id,
          apt_name: item.row.apt_name,
          classification: item.decision.classification,
          derived_pnu: item.decision.derivedPnu,
          parcel_lat: item.point.lat,
          parcel_lng: item.point.lng,
          existing_lat: coord.lat,
          existing_lng: coord.lng,
          existing_source: coord.source ?? null,
          distance_m: round1(d),
          note: "distance is not an automatic reject; existing coordinate is not a parcel representative point",
        });
      }
    }
  }
  distances.sort((a, b) => a - b);
  disagreements.sort((a, b) => Number(b.distance_m) - Number(a.distance_m));

  const total = decided.length;
  const safe = safeItems.length;
  const noSource = counts.NO_SOURCE_PARCEL || 0;
  const exact = counts.EXACT_ORIGINAL || 0;
  const repairedMissing = counts.REPAIRED_FROM_SAME_ROW_LOT || 0;
  const repairedConflict = counts.ORIGINAL_CONFLICT_REPAIRED || 0;
  const sourceRows = total - noSource;
  const overall = total === 0 ? 0 : safe / total;
  const sourceCoverage = sourceRows === 0 ? 0 : safe / sourceRows;
  const unresolved = decided.filter((item) => !isSafeRepairClass(item.decision.classification));
  const noPnu = decided.filter((item) => item.row.identity_status === "NO_PNU");
  const decision =
    sampleGate === "PASS" && jamsilPass && overall >= 0.9 && sourceCoverage >= 0.95 ? "PASS" : "FAIL";

  const summary = {
    mode: "dry-run",
    repair_version: "v1",
    coordinate_source: "CADASTRAL_PARCEL",
    coordinate_semantics: "PARCEL_REPRESENTATIVE_POINT",
    parcel_identity: "SAME_ROW_ADDRESS_DERIVED_PNU",
    fuzzy_matching: false,
    geocoder_calls: 0,
    production_coordinate_rows_written: 0,
    generatedAt: new Date().toISOString(),
    before: {
      total: 8437,
      safe_coordinates: 2643,
      overall_coverage: 0.3133,
      spatial_stage_coverage: 0.3197,
    },
    after: {
      total,
      EXACT_ORIGINAL: exact,
      REPAIRED_FROM_SAME_ROW_LOT: repairedMissing,
      ORIGINAL_CONFLICT_REPAIRED: repairedConflict,
      total_safe_coordinates: safe,
      overall_coverage: Number(overall.toFixed(6)),
      valid_source_row_coverage: Number(sourceCoverage.toFixed(6)),
      unique_safe_pnu: byPnu.size,
    },
    unresolved: {
      NOT_FOUND: counts.NOT_FOUND || 0,
      AMBIGUOUS: counts.AMBIGUOUS || 0,
      NO_SOURCE_PARCEL: noSource,
      NO_PNU_examined: noPnu.length,
      NO_PNU_repaired: noPnu.filter((item) => isSafeRepairClass(item.decision.classification)).length,
    },
    causes,
    gu_patterns: guPatterns,
    dong_patterns: dongPatterns,
    multiplicity: {
      groups: groups.length,
      affected_complexes: groups.reduce((n, [, ids]) => n + ids.length, 0),
      max_complexes_per_pnu: groups[0]?.[1].length ?? 0,
    },
    cross_check: {
      compared,
      repaired_compared: repairedCompared,
      median_m: round1(quantile(distances, 0.5)),
      p75_m: round1(quantile(distances, 0.75)),
      p90_m: round1(quantile(distances, 0.9)),
      p95_m: round1(quantile(distances, 0.95)),
      max_m: round1(distances.length ? distances[distances.length - 1] : null),
      le_50m: bands.le50,
      m50_100: bands.m50_100,
      m100_250: bands.m100_250,
      m250_500: bands.m250_500,
      m500_plus: bands.m500,
      repaired_500m_plus: repairedBands.m500,
    },
    sample: { count: sampleView.length, gate: sampleGate },
    jamsil: {
      classification: jam?.decision.classification ?? null,
      pnu: jam?.decision.derivedPnu ?? null,
      coordinate: jamPoint,
      result: jamsilPass ? "PASS" : "FAIL",
    },
    gate: {
      decision,
      eligibility: decision === "PASS" ? "YES" : "HOLD",
      reason:
        decision === "PASS"
          ? "Same-row lot repair is deterministic. Every safe coordinate is one exact cadastral hit inside Seoul. Jamsil Els stayed EXACT_ORIGINAL. Residual rows are separated and were not guessed."
          : "Sample, Jamsil regression, or coverage did not pass.",
    },
  };

  writeFileSync(join(opts.outDir, "parcel-coordinate-repair-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(opts.outDir, "parcel-coordinate-repair-sample.json"), JSON.stringify({ samples: sampleView, jamsil: summary.jamsil }, null, 2));
  writeFileSync(
    join(opts.outDir, "parcel-coordinate-repair-unresolved.json"),
    JSON.stringify({
      count: unresolved.length,
      rows: unresolved.map((item) => ({
        complex_id: item.row.complex_id,
        apt_name: item.row.apt_name,
        gu: item.row.sigungu,
        dong: item.row.legal_dong,
        identity_status: item.row.identity_status,
        classification: item.decision.classification,
        stored_pnu: item.decision.storedPnu,
        derived_pnu: item.decision.derivedPnu,
        address: item.decision.rawAddress,
        cause: item.decision.cause,
      })),
    }, null, 2),
  );
  writeFileSync(
    join(opts.outDir, "parcel-coordinate-repair-disagreements.json"),
    JSON.stringify({ count: disagreements.length, rows: disagreements }, null, 2),
  );

  return { decision, safe, sampleGate, jamsil: summary.jamsil.result };
}

export type { SameRowRepairClass };
