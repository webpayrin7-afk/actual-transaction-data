/**
 * REB full-PNU identity + official parcel representative-point exact join.
 * Dry-run only. No Production writes. No geocoding. No school materialization.
 *
 *   npx tsx scripts/complex-coordinates/dry_run_parcel_spatial.ts [outDir]
 *
 * Parcel points default to the Seoul continuous-cadastral representative-point ZIP
 * already in the repo root. The extracted CSV is not written into the repo.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { createGunzip } from "zlib";
import { haversineMeters } from "../../src/lib/complex-detail/geo";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";
import {
  composeJibunAddress,
  inSeoulBbox,
  isValidWgs84,
  normalizeJibunAddress,
  parseCadastralPnu,
  parseJibun,
  parsePnu,
  pnuLandAgnosticKey,
  alignedCadastralPnuFromAddress,
  trailingLotAgreesPnu,
} from "../../src/lib/complex-coordinates/parcel-key";
import {
  indexParcelPoints,
  joinExactPnu,
  quantile,
  type IndexedParcel,
  type ParcelPointRow,
} from "../../src/lib/complex-coordinates/parcel-point-join";

const OUT = process.argv[2] || "data/poc/complex-coordinates";
const CACHE = process.env.COORD_SOURCE_CACHE || "/tmp/coord-source";
const ZIP =
  process.env.PARCEL_POINTS_ZIP || "seoul_parcel_coordinates_cursor_input_20260908.zip";
const CSV_NAME = "seoul_parcel_representative_points_20260908.csv.gz";
const META_NAME = "seoul_parcel_representative_points_20260908.metadata.json";

type RebHit = {
  pnu: string;
  pnuKey: string;
  jibun: string | null;
  name: string;
  address: string;
  lotAgrees: boolean | null;
};

type IdentityStatus =
  | "SINGLE_PARCEL"
  | "MULTI_PARCEL"
  | "MULTI_RECORD_SAME_PARCEL"
  | "AMBIGUOUS_IDENTITY"
  | "NO_PNU"
  | "INVALID_PNU";

type IdentityRow = {
  complex_id: string;
  apt_name: string;
  sigungu: string | null;
  jibun_addr: string | null;
  identity_status: IdentityStatus;
  full_pnus: string[];
  match_bridge: "LAND_AGNOSTIC_KEY" | "JIBUN_ADDRESS" | "NONE";
  lot_agrees: boolean | null;
  aligned_pnu: string | null;
};

async function loadReb(): Promise<{ byKey: Map<string, RebHit[]>; byJibun: Map<string, RebHit[]> }> {
  const path = join(CACHE, "reb-seoul-basic.csv");
  if (!existsSync(path)) throw new Error(`REB cache missing: ${path}`);
  const byKey = new Map<string, RebHit[]>();
  const byJibun = new Map<string, RebHit[]>();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  let headers: string[] | null = null;
  for await (const line of rl) {
    if (!headers) {
      headers = splitCsv(line).map((h) => h.trim());
      continue;
    }
    const cols = splitCsv(line);
    const get = (n: string) => {
      const i = headers!.indexOf(n);
      return i >= 0 ? (cols[i] ?? "").trim() : "";
    };
    const pnu = get("필지고유번호").replace(/\s+/g, "");
    const address = get("주소");
    const parsed = parsePnu(pnu);
    if (!parsed) continue;
    const hit: RebHit = {
      pnu: parsed.pnu,
      pnuKey: parsed.bjdong10 + parsed.bun + parsed.ji,
      jibun: normalizeJibunAddress(address),
      name: get("단지명_공시가격"),
      address,
      lotAgrees: trailingLotAgreesPnu(address, parsed.pnu),
    };
    push(byKey, hit.pnuKey, hit);
    if (hit.jibun) push(byJibun, hit.jibun, hit);
  }
  return { byKey, byJibun };
}

function push(map: Map<string, RebHit[]>, key: string, hit: RebHit) {
  const arr = map.get(key) || [];
  arr.push(hit);
  map.set(key, arr);
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function unzipText(entry: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-p", ZIP, entry], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => {
      err += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`unzip ${entry} exit ${code}: ${err}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function validPoint(lat: number, lng: number): boolean {
  return isValidWgs84(lat, lng) && inSeoulBbox(lat, lng);
}

async function loadParcelPoints(): Promise<{
  metadata: Record<string, unknown>;
  rows: ParcelPointRow[];
  integrity: Record<string, unknown>;
}> {
  const metadata = JSON.parse(await unzipText(META_NAME)) as Record<string, unknown>;
  const child = spawn("unzip", ["-p", ZIP, CSV_NAME], { stdio: ["ignore", "pipe", "pipe"] });
  const exitCodeP = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const gunzip = createGunzip();
  child.stdout.pipe(gunzip);
  const rl = createInterface({ input: gunzip });
  const rows: ParcelPointRow[] = [];
  let headerOk = false;
  let badHeader = false;
  let badPnu = 0;
  let badCoord = 0;
  let outsideSeoul = 0;
  let mountain = 0;
  const dates = new Map<string, number>();
  const methods = new Map<string, number>();
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!headerOk) {
      headerOk = true;
      if (line.trim() !== "pnu,latitude,longitude,source_date,method") badHeader = true;
      continue;
    }
    const parts = line.split(",");
    if (parts.length !== 5) {
      badPnu += 1;
      continue;
    }
    const [pnuRaw, latRaw, lngRaw, sourceDate, method] = parts;
    const parsed = parseCadastralPnu(pnuRaw);
    if (!parsed) {
      badPnu += 1;
      continue;
    }
    if (parsed.platGb === "2") mountain += 1;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isValidWgs84(lat, lng)) {
      badCoord += 1;
      continue;
    }
    if (!inSeoulBbox(lat, lng)) outsideSeoul += 1;
    dates.set(sourceDate, (dates.get(sourceDate) || 0) + 1);
    methods.set(method, (methods.get(method) || 0) + 1);
    rows.push({ pnu: parsed.pnu, lat, lng, sourceDate, method });
  }
  const exitCode = await exitCodeP;
  if (exitCode !== 0) throw new Error(`unzip csv exit ${exitCode}`);
  const index = indexParcelPoints(rows);
  let duplicateIdentical = 0;
  let duplicateConflict = 0;
  for (const v of index.values()) {
    if (v.status === "DUPLICATE_IDENTICAL") duplicateIdentical += 1;
    if (v.status === "DUPLICATE_CONFLICT") duplicateConflict += 1;
  }
  const integrity = {
    header_ok: headerOk && !badHeader,
    data_rows: lineNo - 1,
    indexed_rows: rows.length,
    unique_pnu: index.size,
    bad_pnu: badPnu,
    bad_coordinate: badCoord,
    outside_seoul_bbox: outsideSeoul,
    mountain_plat2: mountain,
    duplicate_identical_pnu: duplicateIdentical,
    duplicate_conflict_pnu: duplicateConflict,
    source_date: Object.fromEntries(dates),
    method: Object.fromEntries(methods),
    metadata_output_rows: metadata.output_rows ?? null,
    metadata_target_crs: metadata.target_crs ?? null,
    metadata_source_crs: metadata.source_crs ?? null,
  };
  return { metadata, rows, integrity };
}

function pickSamples(rows: IdentityRow[]): IdentityRow[] {
  const out: IdentityRow[] = [];
  const seen = new Set<string>();
  const add = (row: IdentityRow | undefined) => {
    if (!row || seen.has(row.complex_id) || out.length >= 50) return;
    seen.add(row.complex_id);
    out.push(row);
  };
  add(rows.find((r) => r.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId));
  const gus = [...new Set(rows.map((r) => r.sigungu).filter((g): g is string => Boolean(g)))].sort();
  for (const gu of gus) {
    const singles = rows
      .filter((r) => r.sigungu === gu && r.identity_status === "SINGLE_PARCEL")
      .sort((a, b) => a.complex_id.localeCompare(b.complex_id));
    add(singles[0]);
  }
  for (const st of ["MULTI_RECORD_SAME_PARCEL", "MULTI_PARCEL", "NO_PNU", "INVALID_PNU"] as const) {
    add(rows.find((r) => r.identity_status === st));
  }
  add(rows.find((r) => r.identity_status === "SINGLE_PARCEL" && r.full_pnus[0]?.[10] === "2"));
  return out;
}

function round1(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

async function main() {
  if (process.argv.includes("--write")) {
    console.error("WRITE GUARD: parcel spatial dry-run refuses --write");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(ZIP)) throw new Error(`parcel points zip missing: ${ZIP}`);

  const started = Date.now();
  const zipBytes = readFileSync(ZIP);
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");
  const loaded = await loadParcelPoints();
  const { metadata, rows: parcelRows, integrity } = loaded;
  const index: Map<string, IndexedParcel> = indexParcelPoints(parcelRows);
  const loadMs = Date.now() - started;

  const integrityOk =
    integrity.header_ok === true &&
    integrity.bad_pnu === 0 &&
    integrity.bad_coordinate === 0 &&
    integrity.outside_seoul_bbox === 0 &&
    integrity.metadata_target_crs === "EPSG:4326" &&
    integrity.metadata_source_crs === "EPSG:5186" &&
    Number(integrity.data_rows) === Number(metadata.output_rows);

  const baseSource = {
    provider: "국토교통부",
    dataset: String(metadata.source_dataset ?? "일별연속지적도형정보 서울특별시"),
    source_file: metadata.source_file ?? null,
    source_date_feature: Object.keys((integrity.source_date as object) || {}),
    source_crs: metadata.source_crs ?? null,
    output_crs: metadata.target_crs ?? null,
    coordinate_semantics: "PARCEL_REPRESENTATIVE_POINT",
    method: metadata.method ?? null,
    zip_sha256: sha256,
    retrievedAt: new Date().toISOString(),
    pnu_field: "pnu (19-digit string; plat 1=일반, 2=임야; not numeric)",
  };

  if (!integrityOk) {
    const summary = {
      mode: "dry-run",
      gate: "STOP_INPUT_INTEGRITY",
      production_coordinate_rows_written: 0,
      school_rerun: false,
      spatial_source: baseSource,
      integrity,
      load_ms: loadMs,
    };
    writeFileSync(join(OUT, "parcel-coordinate-full-summary.json"), JSON.stringify(summary, null, 2));
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const { byKey, byJibun } = await loadReb();
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  const master = await db.execute({
    sql: `SELECT complex_id, apt_name, sigungu, lawd_cd, legal_dong_name, bjdong_cd, jibun
          FROM apt_complex_master WHERE sido LIKE ? ORDER BY complex_id`,
    args: ["%서울%"],
  });

  const counts: Record<string, number> = {};
  const identityRows: IdentityRow[] = [];
  const allPnus = new Set<string>();

  for (const r of master.rows) {
    const jibun = r.jibun == null ? null : String(r.jibun);
    const parts = parseJibun(jibun);
    const jibunAddr = composeJibunAddress({
      sido: "서울특별시",
      sigungu: r.sigungu == null ? null : String(r.sigungu),
      dong: r.legal_dong_name == null ? null : String(r.legal_dong_name),
      jibun,
    });
    let key: string | null = null;
    if (parts && r.lawd_cd && r.bjdong_cd) {
      const composed = `${r.lawd_cd}${r.bjdong_cd}0${parts.bun}${parts.ji}`;
      key = pnuLandAgnosticKey(composed);
    }
    const keyHits = key ? byKey.get(key) || [] : [];
    const jibunHits = !keyHits.length && jibunAddr ? byJibun.get(jibunAddr) || [] : [];
    const hits = keyHits.length ? keyHits : jibunHits;
    const full = [...new Set(hits.map((h) => h.pnu))];
    const keys = [...new Set(hits.map((h) => h.pnuKey))];
    let status: IdentityStatus;
    if (hits.length === 0) status = parts ? "NO_PNU" : "INVALID_PNU";
    else if (keys.length > 1) status = "AMBIGUOUS_IDENTITY";
    else if (full.length > 1) status = "MULTI_PARCEL";
    else if (hits.length > 1) status = "MULTI_RECORD_SAME_PARCEL";
    else status = "SINGLE_PARCEL";
    counts[status] = (counts[status] || 0) + 1;
    for (const p of full) allPnus.add(p);
    const chosenHits = hits.filter((h) => full.length === 1 && h.pnu === full[0]);
    const lotFlags = chosenHits.map((h) => h.lotAgrees);
    const lotAgrees = lotFlags.length === 0 ? null : lotFlags.every((v) => v === true) ? true : lotFlags.some((v) => v === false) ? false : null;
    const aligned = full.length === 1 ? alignedCadastralPnuFromAddress(full[0], chosenHits[0]?.address ?? null) : null;
    identityRows.push({
      complex_id: String(r.complex_id),
      apt_name: String(r.apt_name ?? ""),
      sigungu: r.sigungu == null ? null : String(r.sigungu),
      jibun_addr: jibunAddr,
      identity_status: status,
      full_pnus: full,
      match_bridge: keyHits.length ? "LAND_AGNOSTIC_KEY" : jibunHits.length ? "JIBUN_ADDRESS" : "NONE",
      lot_agrees: lotAgrees,
      aligned_pnu: aligned,
    });
  }

  const joinStarted = Date.now();
  const joined = identityRows.map((row) => {
    const spatial = joinExactPnu(row.full_pnus, index, validPoint);
    return { ...row, spatial };
  });
  const joinMs = Date.now() - joinStarted;

  const jamRow = joined.find((r) => r.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId);
  const jamDist =
    jamRow?.spatial.lat != null && jamRow.spatial.lng != null
      ? haversineMeters(
          jamRow.spatial.lat,
          jamRow.spatial.lng,
          JAMSIL_ELS_CANONICAL_CENTER.lat,
          JAMSIL_ELS_CANONICAL_CENTER.lng,
        )
      : null;
  const jamsil = {
    complex_id: JAMSIL_ELS_CANONICAL_CENTER.complexId,
    apt_name: jamRow?.apt_name ?? JAMSIL_ELS_CANONICAL_CENTER.complexName,
    reb_pnu: jamRow?.full_pnus ?? [],
    spatial_pnu: jamRow?.spatial.spatialPnu ?? null,
    geometry: "representative point (precomputed; polygon not in this file)",
    representative_point:
      jamRow?.spatial.lat != null
        ? { lat: jamRow.spatial.lat, lng: jamRow.spatial.lng }
        : null,
    known_product_anchor: {
      lat: JAMSIL_ELS_CANONICAL_CENTER.lat,
      lng: JAMSIL_ELS_CANONICAL_CENTER.lng,
    },
    distance_m: round1(jamDist),
    status: jamRow?.spatial.status ?? "MISSING_COMPLEX",
    lot_agrees: jamRow?.lot_agrees ?? null,
    identity_status: jamRow?.identity_status ?? null,
    result:
      jamRow?.spatial.status === "EXACT_PNU" &&
      jamRow.lot_agrees === true &&
      jamRow.full_pnus[0] === "1171010100100190000" &&
      jamRow.spatial.lat != null &&
      jamRow.spatial.lng != null &&
      validPoint(jamRow.spatial.lat, jamRow.spatial.lng)
        ? "PASS"
        : "FAIL",
  };

  const sampleRows = pickSamples(identityRows);
  const samples = sampleRows.map((row) => {
    const hit = joined.find((j) => j.complex_id === row.complex_id)!;
    return {
      complex_id: hit.complex_id,
      apt_name: hit.apt_name,
      gu: hit.sigungu,
      reb_pnu: hit.full_pnus,
      parcel_lat: hit.spatial.lat,
      parcel_lng: hit.spatial.lng,
      identity_status: hit.identity_status,
      identity_bridge: hit.match_bridge,
      join_status: hit.spatial.status === "EXACT_PNU" && hit.lot_agrees === false ? "PNU_LOT_CONFLICT" : hit.spatial.status,
      spatial_pnu: hit.spatial.spatialPnu,
    };
  });
  const sampleStructural = samples.filter((s) => {
    const strict = s.identity_status === "SINGLE_PARCEL" || s.identity_status === "MULTI_RECORD_SAME_PARCEL";
    if (!strict) return false;
    return s.join_status !== "EXACT_PNU";
  });

  const strictStatuses = new Set(["SINGLE_PARCEL", "MULTI_RECORD_SAME_PARCEL"]);
  let validStrict = 0;
  let matched = 0;
  let matchedLotConflict = 0;
  let spatialMissing = 0;
  let alignedPresent = 0;
  let noOrInvalid = 0;
  let multiParcel = 0;
  let ambiguous = 0;
  let duplicateGeometry = 0;
  let invalidGeometry = 0;
  const unresolved: Array<Record<string, unknown>> = [];
  const byPnu = new Map<string, string[]>();

  for (const row of joined) {
    const strict = strictStatuses.has(row.identity_status) && row.full_pnus.length === 1 && Boolean(parseCadastralPnu(row.full_pnus[0]));
    if (row.identity_status === "NO_PNU" || row.identity_status === "INVALID_PNU") noOrInvalid += 1;
    if (row.identity_status === "AMBIGUOUS_IDENTITY") ambiguous += 1;
    if (row.identity_status === "MULTI_PARCEL") multiParcel += 1;
    if (strict) validStrict += 1;
    const lotConflict = row.spatial.status === "EXACT_PNU" && row.lot_agrees === false;
    const resolved = strict && row.spatial.status === "EXACT_PNU" && row.lot_agrees === true && row.spatial.lat != null && row.spatial.lng != null;
    if (lotConflict) matchedLotConflict += 1;
    if (
      row.spatial.status === "PNU_NOT_FOUND" &&
      row.aligned_pnu &&
      index.get(row.aligned_pnu) &&
      index.get(row.aligned_pnu)!.status !== "DUPLICATE_CONFLICT"
    ) {
      alignedPresent += 1;
    }
    const joinStatus = lotConflict ? "PNU_LOT_CONFLICT" : row.spatial.status;
    if (resolved && row.spatial.spatialPnu) {
      matched += 1;
      const list = byPnu.get(row.spatial.spatialPnu) || [];
      list.push(row.complex_id);
      byPnu.set(row.spatial.spatialPnu, list);
    } else {
      if (strict && row.spatial.status === "PNU_NOT_FOUND") spatialMissing += 1;
      if (row.spatial.status === "DUPLICATE_GEOMETRY") duplicateGeometry += 1;
      if (row.spatial.status === "INVALID_GEOMETRY") invalidGeometry += 1;
      unresolved.push({
        complex_id: row.complex_id,
        apt_name: row.apt_name,
        gu: row.sigungu,
        identity_status: row.identity_status,
        reb_pnu: row.full_pnus,
        join_status: joinStatus,
        aligned_pnu: row.aligned_pnu,
      });
    }
  }

  const idByPnu = new Map<string, string[]>();
  for (const row of identityRows) {
    if (row.full_pnus.length !== 1) continue;
    const list = idByPnu.get(row.full_pnus[0]) || [];
    list.push(row.complex_id);
    idByPnu.set(row.full_pnus[0], list);
  }
  const multiGroups = [...idByPnu.entries()].filter(([, ids]) => ids.length > 1);
  multiGroups.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const affected = multiGroups.reduce((n, [, ids]) => n + ids.length, 0);
  const nameById = new Map(joined.map((r) => [r.complex_id, r.apt_name]));
  const multiExamples = multiGroups.slice(0, 5).map(([pnu, ids]) => ({
    pnu,
    complexes: ids.length,
    examples: ids.slice(0, 4).map((id) => ({ complex_id: id, apt_name: nameById.get(id) })),
  }));

  const knownPath = join(OUT, "coordinate-source-gate-overrides.json");
  const distances: number[] = [];
  const bands = { le50: 0, m50_100: 0, m100_250: 0, m250_500: 0, m500: 0 };
  const disagreements: Array<Record<string, unknown>> = [];
  let compared = 0;
  if (existsSync(knownPath)) {
    const known = JSON.parse(readFileSync(knownPath, "utf8")) as {
      overrides?: Record<string, { lat: number; lng: number; source?: string; method?: string }>;
    };
    for (const [id, coord] of Object.entries(known.overrides || {})) {
      const row = joined.find((r) => r.complex_id === id);
      if (!row || row.lot_agrees !== true || row.spatial.lat == null || row.spatial.lng == null) continue;
      compared += 1;
      const d = haversineMeters(row.spatial.lat, row.spatial.lng, coord.lat, coord.lng);
      distances.push(d);
      if (d <= 50) bands.le50 += 1;
      else if (d <= 100) bands.m50_100 += 1;
      else if (d <= 250) bands.m100_250 += 1;
      else if (d <= 500) bands.m250_500 += 1;
      else {
        bands.m500 += 1;
        disagreements.push({
          complex_id: id,
          apt_name: row.apt_name,
          gu: row.sigungu,
          reb_pnu: row.full_pnus,
          parcel_lat: row.spatial.lat,
          parcel_lng: row.spatial.lng,
          existing_lat: coord.lat,
          existing_lng: coord.lng,
          existing_source: coord.source ?? null,
          existing_method: coord.method ?? null,
          distance_m: round1(d),
          note: "existing coordinate meaning is not parcel representative point; distance is not an automatic reject",
        });
      }
    }
  }
  distances.sort((a, b) => a - b);
  disagreements.sort((a, b) => Number(b.distance_m) - Number(a.distance_m));

  const total = identityRows.length;
  const spatialCoverage = validStrict === 0 ? 0 : matched / validStrict;
  const overallCoverage = total === 0 ? 0 : matched / total;
  const sampleGate =
    jamsil.result === "PASS" && sampleStructural.length === 0 ? "PASS" : "FAIL";
  const decision =
    sampleGate === "PASS" && spatialCoverage >= 0.99 && duplicateGeometry === 0 && invalidGeometry === 0
      ? "PASS"
      : spatialCoverage >= 0.9 && jamsil.result === "PASS"
        ? "PARTIAL"
        : "FAIL";

  const reasonBy = new Map<string, number>();
  for (const u of unresolved) {
    const k = `${u.identity_status}|${u.join_status}`;
    reasonBy.set(k, (reasonBy.get(k) || 0) + 1);
  }

  const summary = {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    production_coordinate_rows_written: 0,
    production_school_rows_written: 0,
    production_schema_changed: false,
    production_deploy: false,
    school_rerun: false,
    coordinate_semantics: "PARCEL_REPRESENTATIVE_POINT",
    source: baseSource,
    integrity,
    load_ms: loadMs,
    join_ms: joinMs,
    runtime_ms: Date.now() - started,
    reb_identity: {
      total,
      SINGLE_PARCEL: counts.SINGLE_PARCEL || 0,
      MULTI_RECORD_SAME_PARCEL: counts.MULTI_RECORD_SAME_PARCEL || 0,
      MULTI_PARCEL: counts.MULTI_PARCEL || 0,
      AMBIGUOUS_IDENTITY: counts.AMBIGUOUS_IDENTITY || 0,
      NO_PNU: counts.NO_PNU || 0,
      INVALID_PNU: counts.INVALID_PNU || 0,
      unique_full_pnu: allPnus.size,
      high_confidence_identity:
        (counts.SINGLE_PARCEL || 0) +
        (counts.MULTI_RECORD_SAME_PARCEL || 0) +
        (counts.MULTI_PARCEL || 0),
    },
    coverage: {
      total_complexes: total,
      valid_strict_pnu: validStrict,
      coordinate_matched: matched,
      exact_pnu_field_hit: matched + matchedLotConflict,
      overall_coverage: Number(overallCoverage.toFixed(6)),
      pnu_stage_coverage: Number((validStrict / total).toFixed(6)),
      spatial_stage_coverage: Number(spatialCoverage.toFixed(6)),
      unique_pnu: allPnus.size,
      matched_unique_pnu: byPnu.size,
      valid_pnu_spatial_missing: spatialMissing,
      exact_match_lot_conflict: matchedLotConflict,
      missing_pnu_address_lot_present: alignedPresent,
      no_or_invalid_pnu: noOrInvalid,
      multi_parcel: multiParcel,
      ambiguous_identity: ambiguous,
      duplicate_geometry: duplicateGeometry,
      invalid_geometry: invalidGeometry,
    },
    multiplicity: {
      source_duplicate_identical_pnu: integrity.duplicate_identical_pnu,
      source_duplicate_conflict_pnu: integrity.duplicate_conflict_pnu,
      multi_complex_pnu_groups: multiGroups.length,
      affected_complexes: affected,
      max_complexes_per_pnu: multiGroups[0]?.[1].length ?? 0,
      examples: multiExamples,
    },
    cross_check: {
      compared,
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
      note: "Compared to prior public-source gate overrides. Those coordinates are not parcel representative points.",
    },
    jamsil_els: jamsil,
    sample: {
      count: samples.length,
      structural_issues: sampleStructural.length,
      gate: sampleGate,
    },
    unresolved_breakdown: Object.fromEntries([...reasonBy.entries()].sort()),
    gate: {
      pnu_exact_join: true,
      coordinate_sanity: integrity.outside_seoul_bbox === 0,
      spatial_coverage: spatialCoverage,
      decision,
      reason:
        decision === "PASS"
          ? "Exact PNU join is stable, Jamsil Els matched, sample has no structural miss, and spatial-stage coverage of strict PNU is at least 99%."
          : "Jamsil Els exact join passed, but many REB 필지고유번호 values store 부번 0000 while the same row 주소 has a non-zero 부번. Those rows are not counted as high-confidence coordinates.",
    },
  };

  writeFileSync(join(OUT, "parcel-coordinate-full-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT, "parcel-coordinate-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT, "parcel-coordinate-sample.json"), JSON.stringify({ jamsil_els: jamsil, samples }, null, 2));
  writeFileSync(join(OUT, "parcel-coordinate-unresolved.json"), JSON.stringify({ count: unresolved.length, rows: unresolved }, null, 2));
  writeFileSync(
    join(OUT, "parcel-coordinate-disagreements.json"),
    JSON.stringify({ count: disagreements.length, rows: disagreements }, null, 2),
  );
  const csv = [
    "complex_id,apt_name,sigungu,identity_status,join_status,full_pnus",
    ...unresolved.map((x) =>
      [
        x.complex_id,
        JSON.stringify(x.apt_name),
        x.gu ?? "",
        x.identity_status,
        x.join_status,
        JSON.stringify(x.reb_pnu),
      ].join(","),
    ),
  ].join("\n");
  writeFileSync(join(OUT, "parcel-coordinate-unresolved.csv"), csv);

  console.log(
    JSON.stringify(
      {
        total,
        validStrict,
        matched,
        spatialCoverage: summary.coverage.spatial_stage_coverage,
        jamsil: jamsil.result,
        jamsil_distance_m: jamsil.distance_m,
        decision,
        compared,
        unresolved: unresolved.length,
        runtime_ms: summary.runtime_ms,
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
