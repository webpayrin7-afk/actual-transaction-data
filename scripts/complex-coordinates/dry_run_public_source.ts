/**
 * Seoul public-source coordinate discovery + exact-match DRY-RUN.
 *
 * - No Production writes
 * - No school materialization
 * - No mass NAVER/Nominatim geocode
 * - OpenAptInfo full pull only when SEOUL_OPENAPI_KEY is present
 *
 * Usage:
 *   npx tsx scripts/complex-coordinates/dry_run_public_source.ts [outDir]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { createHash } from "crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { haversineMeters } from "../../src/lib/complex-detail/geo";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";
import {
  buildPnu,
  composeJibunAddress,
  inSeoulBbox,
  isValidWgs84,
  normalizeJibunAddress,
  normalizeRoadAddress,
  parseJibun,
  pnuLandAgnosticKey,
  roadAddressJoinKey,
} from "../../src/lib/complex-coordinates/parcel-key";

const OUT = process.argv[2] || "data/poc/complex-coordinates";
const CACHE = process.env.COORD_SOURCE_CACHE || "/tmp/coord-source";
const SOURCE_VERSION = "public-source-discovery-2026-09-18";

type MatchStatus =
  | "EXACT_OFFICIAL_ID"
  | "EXACT_PARCEL"
  | "EXACT_ROAD_ADDRESS"
  | "EXACT_JIBUN_ADDRESS"
  | "MULTI_RECORD_RESOLVED"
  | "MULTI_RECORD_SAME_PARCEL"
  | "AMBIGUOUS"
  | "NO_MATCH"
  | "INVALID_SOURCE_COORD"
  | "INVALID_COORD";

type ComplexRow = {
  complex_id: string;
  apt_name: string;
  sigungu: string | null;
  lawd_cd: string | null;
  legal_dong_name: string | null;
  bjdong_cd: string | null;
  jibun: string | null;
  road_address: string | null;
  identity_status: string | null;
  kapt_code: string | null;
  hub_pnu: string | null;
};

type CoordHit = {
  lat: number;
  lng: number;
  source: string;
  source_id: string;
  source_address: string | null;
  method: MatchStatus;
  coordinate_meaning: string;
  crs: string;
};

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.every((c) => !c.trim())) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (cols[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadComplexes(): Promise<ComplexRow[]> {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  const master = await db.execute({
    sql: `SELECT complex_id, apt_name, sigungu, lawd_cd, legal_dong_name, bjdong_cd,
                 jibun, road_address, identity_status
          FROM apt_complex_master
          WHERE sido LIKE ?
          ORDER BY complex_id`,
    args: ["%서울%"],
  });

  const kapt = await db.execute({
    sql: `SELECT complex_id, source_key FROM apt_complex_source_links
          WHERE source = 'KAPT'`,
  });
  const hub = await db.execute({
    sql: `SELECT complex_id, source_key FROM apt_complex_source_links
          WHERE source = 'BUILDING_HUB_PARCEL'`,
  });
  const kaptMap = new Map(
    kapt.rows.map((r) => [String(r.complex_id), String(r.source_key).trim()]),
  );
  const hubMap = new Map(
    hub.rows.map((r) => [String(r.complex_id), String(r.source_key).trim()]),
  );

  return master.rows.map((r) => ({
    complex_id: String(r.complex_id),
    apt_name: String(r.apt_name ?? ""),
    sigungu: r.sigungu == null ? null : String(r.sigungu),
    lawd_cd: r.lawd_cd == null ? null : String(r.lawd_cd),
    legal_dong_name: r.legal_dong_name == null ? null : String(r.legal_dong_name),
    bjdong_cd: r.bjdong_cd == null ? null : String(r.bjdong_cd),
    jibun: r.jibun == null ? null : String(r.jibun),
    road_address: r.road_address == null ? null : String(r.road_address),
    identity_status: r.identity_status == null ? null : String(r.identity_status),
    kapt_code: kaptMap.get(String(r.complex_id)) ?? null,
    hub_pnu: hubMap.get(String(r.complex_id)) ?? null,
  }));
}

type RebRow = {
  complex_id_reb: string;
  pnu: string;
  pnu_key: string;
  jibun_addr: string | null;
  road_addr: string | null;
  road_key: string | null;
  name: string;
};

async function loadRebSeoul(): Promise<RebRow[]> {
  const path = join(CACHE, "reb-seoul-basic.csv");
  if (!existsSync(path)) {
    console.warn("REB Seoul CSV missing:", path);
    return [];
  }
  const rows: RebRow[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  let headers: string[] | null = null;
  for await (const line of rl) {
    if (!headers) {
      headers = splitCsvLine(line).map((h) => h.trim());
      continue;
    }
    const cols = splitCsvLine(line);
    const get = (name: string) => {
      const i = headers!.indexOf(name);
      return i >= 0 ? (cols[i] ?? "").trim() : "";
    };
    const pnu = get("필지고유번호").replace(/\s+/g, "");
    const key = pnuLandAgnosticKey(pnu);
    if (!key) continue;
    rows.push({
      complex_id_reb: get("단지고유번호").trim(),
      pnu,
      pnu_key: key,
      jibun_addr: normalizeJibunAddress(get("주소")),
      road_addr: normalizeRoadAddress(
        get("도로명주소") ? `서울특별시 ${get("도로명주소")}` : null,
      ),
      road_key: roadAddressJoinKey(
        get("도로명주소") ? `서울특별시 ${get("도로명주소")}` : null,
      ),
      name: get("단지명_공시가격") || get("단지명_건축물대장") || "",
    });
  }
  return rows;
}

type PublicCoordRow = {
  source: string;
  source_id: string;
  road_norm: string | null;
  road_key: string | null;
  jibun_norm: string | null;
  lat: number;
  lng: number;
  raw_name: string;
  meaning: string;
};

function loadGuCoordCsvs(): PublicCoordRow[] {
  const out: PublicCoordRow[] = [];

  const seodaemun = join(CACHE, "downloads/15055494.csv");
  if (existsSync(seodaemun)) {
    const rows = parseCsv(readFileSync(seodaemun, "utf8"));
    for (const r of rows) {
      const lng = Number(r["좌표(X)"]);
      const lat = Number(r["좌표(Y)"]);
      if (!isValidWgs84(lat, lng)) continue;
      out.push({
        source: "seodaemun_apt_status_csv",
        source_id: `${r["아파트명"]}|${r["도로명주소"]}`,
        road_norm: normalizeRoadAddress(r["도로명주소"]),
        road_key: roadAddressJoinKey(r["도로명주소"]),
        jibun_norm: null,
        lat,
        lng,
        raw_name: r["아파트명"] || "",
        meaning: "complex_representative_point_unknown_semantics",
      });
    }
  }

  const dobong = join(CACHE, "downloads/15028125.csv");
  if (existsSync(dobong)) {
    const rows = parseCsv(readFileSync(dobong, "utf8"));
    for (const r of rows) {
      const lat = Number(r["위도"]);
      const lng = Number(r["경도"]);
      if (!isValidWgs84(lat, lng)) continue;
      out.push({
        source: "dobong_apt_status_csv_2018",
        source_id: `${r["시설명"]}|${r["주소"]}`,
        road_norm: normalizeRoadAddress(r["주소"]),
        road_key: roadAddressJoinKey(r["주소"]),
        jibun_norm: normalizeJibunAddress(r["구주소"]),
        lat,
        lng,
        raw_name: r["시설명"] || "",
        meaning: "facility_point_unknown_semantics",
      });
    }
  }

  const samplePath = join(CACHE, "openaptinfo_sample5.json");
  if (existsSync(samplePath)) {
    const rows = JSON.parse(readFileSync(samplePath, "utf8")) as Array<
      Record<string, string>
    >;
    for (const r of rows) {
      const lng = Number(r.XCRD);
      const lat = Number(r.YCRD);
      if (!isValidWgs84(lat, lng)) continue;
      out.push({
        source: "seoul_openaptinfo_sample",
        source_id: r.APT_CD,
        road_norm: normalizeRoadAddress(r.APT_RDN_ADDR),
        road_key: roadAddressJoinKey(r.APT_RDN_ADDR),
        jibun_norm: null,
        lat,
        lng,
        raw_name: r.APT_NM || "",
        meaning: "openapt_xcrd_ycrd_wgs84",
      });
    }
  }

  return out;
}

async function maybeLoadOpenAptInfoFull(): Promise<PublicCoordRow[]> {
  const key = process.env.SEOUL_OPENAPI_KEY?.trim();
  if (!key) return [];
  const cachePath = join(CACHE, "openaptinfo_seoul_full.json");
  let rows: Array<Record<string, string>> = [];
  if (existsSync(cachePath)) {
    rows = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
    const base = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/OpenAptInfo`;
    const first = await fetch(`${base}/1/1/`).then((r) => r.json());
    const total = Number(first?.OpenAptInfo?.list_total_count || 0);
    const by = new Map<string, Record<string, string>>();
    for (let start = 1; start <= total; start += 1000) {
      const end = Math.min(start + 999, total);
      const d = await fetch(`${base}/${start}/${end}/`).then((r) => r.json());
      for (const row of d?.OpenAptInfo?.row || []) by.set(row.APT_CD, row);
    }
    rows = [...by.values()];
    writeFileSync(cachePath, JSON.stringify(rows));
  }
  return rows.flatMap((r) => {
      const lng = Number(r.XCRD);
      const lat = Number(r.YCRD);
      if (!isValidWgs84(lat, lng)) return [];
      const row: PublicCoordRow = {
        source: "seoul_openaptinfo",
        source_id: r.APT_CD,
        road_norm: normalizeRoadAddress(r.APT_RDN_ADDR),
        road_key: roadAddressJoinKey(r.APT_RDN_ADDR),
        jibun_norm: null,
        lat,
        lng,
        raw_name: r.APT_NM || "",
        meaning: "openapt_xcrd_ycrd_wgs84",
      };
      return [row];
    });
}

function pickCoord(
  candidates: PublicCoordRow[],
): { status: MatchStatus; hit: CoordHit | null } {
  if (candidates.length === 0) return { status: "NO_MATCH", hit: null };
  const valid = candidates.filter((c) => inSeoulBbox(c.lat, c.lng));
  if (valid.length === 0) {
    return {
      status: "INVALID_SOURCE_COORD",
      hit: {
        lat: candidates[0].lat,
        lng: candidates[0].lng,
        source: candidates[0].source,
        source_id: candidates[0].source_id,
        source_address: candidates[0].road_norm,
        method: "INVALID_SOURCE_COORD",
        coordinate_meaning: candidates[0].meaning,
        crs: "EPSG:4326",
      },
    };
  }
  // cluster by rounded coord
  const groups = new Map<string, PublicCoordRow[]>();
  for (const c of valid) {
    const k = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
    const arr = groups.get(k) || [];
    arr.push(c);
    groups.set(k, arr);
  }
  if (groups.size > 1) {
    // multi distinct points → ambiguous unless within 50m of each other
    const pts = [...groups.values()].map((g) => g[0]);
    let maxD = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        maxD = Math.max(
          maxD,
          haversineMeters(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng),
        );
      }
    }
    if (maxD > 50) return { status: "AMBIGUOUS", hit: null };
  }
  const best = valid[0];
  const method: MatchStatus =
    groups.size === 1 && valid.length > 1
      ? "MULTI_RECORD_RESOLVED"
      : best.source_id.startsWith("A")
        ? "EXACT_OFFICIAL_ID"
        : best.road_norm
          ? "EXACT_ROAD_ADDRESS"
          : "EXACT_JIBUN_ADDRESS";
  return {
    status: method,
    hit: {
      lat: best.lat,
      lng: best.lng,
      source: best.source,
      source_id: best.source_id,
      source_address: best.road_norm || best.jibun_norm,
      method,
      coordinate_meaning: best.meaning,
      crs: "EPSG:4326",
    },
  };
}

async function main() {
  if (process.argv.includes("--write")) {
    console.error("WRITE GUARD: public-source dry-run refuses --write");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  const complexes = await loadComplexes();
  const reb = await loadRebSeoul();
  const guCoords = loadGuCoordCsvs();
  const openAptFull = await maybeLoadOpenAptInfoFull();
  const coordRows = [...guCoords, ...openAptFull];

  const rebByPnu = new Map<string, RebRow[]>();
  const rebByJibun = new Map<string, RebRow[]>();
  for (const r of reb) {
    const a = rebByPnu.get(r.pnu_key) || [];
    a.push(r);
    rebByPnu.set(r.pnu_key, a);
    if (r.jibun_addr) {
      const b = rebByJibun.get(r.jibun_addr) || [];
      b.push(r);
      rebByJibun.set(r.jibun_addr, b);
    }
  }

  const roadIndex = new Map<string, PublicCoordRow[]>();
  const jibunIndex = new Map<string, PublicCoordRow[]>();
  const kaptIndex = new Map<string, PublicCoordRow[]>();
  for (const c of coordRows) {
    if (c.road_key) {
      const a = roadIndex.get(c.road_key) || [];
      a.push(c);
      roadIndex.set(c.road_key, a);
    }
    if (c.jibun_norm) {
      const a = jibunIndex.get(c.jibun_norm) || [];
      a.push(c);
      jibunIndex.set(c.jibun_norm, a);
    }
    if (c.source.includes("openapt") && c.source_id) {
      const a = kaptIndex.get(c.source_id) || [];
      a.push(c);
      kaptIndex.set(c.source_id, a);
    }
  }

  type Result = {
    complex_id: string;
    apt_name: string;
    sigungu: string | null;
    our_jibun_addr: string | null;
    our_road_addr: string | null;
    our_pnu0: string | null;
    our_pnu_key: string | null;
    reb_status: MatchStatus | "NO_REB";
    reb_pnu: string | null;
    reb_id: string | null;
    coord_status: MatchStatus;
    lat: number | null;
    lng: number | null;
    coord_source: string | null;
    coord_source_id: string | null;
    coord_method: string | null;
    gate_eligible: boolean;
  };

  const results: Result[] = [];
  const counts: Record<string, number> = {};
  const rebCounts: Record<string, number> = {};
  let pnu0Ok = 0;
  let pnuKeyOk = 0;
  let bunJiOk = 0;

  for (const c of complexes) {
    const parts = parseJibun(c.jibun);
    if (parts) bunJiOk += 1;
    const pnu0 =
      parts && c.lawd_cd && c.bjdong_cd
        ? buildPnu({
            lawdCd: c.lawd_cd,
            bjdongCd: c.bjdong_cd,
            platGb: "0",
            bun: parts.bun,
            ji: parts.ji,
          })
        : null;
    const pnuKey = pnu0
      ? pnuLandAgnosticKey(pnu0)
      : c.hub_pnu
        ? pnuLandAgnosticKey(c.hub_pnu)
        : null;
    if (pnu0) pnu0Ok += 1;
    if (pnuKey) pnuKeyOk += 1;

    const jibunAddr = composeJibunAddress({
      sido: "서울특별시",
      sigungu: c.sigungu,
      dong: c.legal_dong_name,
      jibun: c.jibun,
    });
    const roadAddr = normalizeRoadAddress(c.road_address);

    // REB identity join
    let rebStatus: MatchStatus | "NO_REB" = "NO_MATCH";
    let rebPnu: string | null = null;
    let rebId: string | null = null;
    const rebHits =
      (pnuKey ? rebByPnu.get(pnuKey) : null) ||
      (jibunAddr ? rebByJibun.get(jibunAddr) : null) ||
      [];
    if (rebHits.length === 1) {
      rebStatus = pnuKey && rebByPnu.get(pnuKey)?.length ? "EXACT_PARCEL" : "EXACT_JIBUN_ADDRESS";
      rebPnu = rebHits[0].pnu;
      rebId = rebHits[0].complex_id_reb;
    } else if (rebHits.length > 1) {
      const uniqPnu = new Set(rebHits.map((h) => h.pnu_key));
      if (uniqPnu.size === 1) {
        rebStatus = "MULTI_RECORD_SAME_PARCEL";
        rebPnu = rebHits[0].pnu;
        rebId = rebHits[0].complex_id_reb;
      } else {
        rebStatus = "AMBIGUOUS";
      }
    } else {
      rebStatus = "NO_MATCH";
    }
    rebCounts[rebStatus] = (rebCounts[rebStatus] || 0) + 1;

    const roadKey = roadAddressJoinKey(c.road_address);

    // Coordinate join (available public coord tables only).
    // Master road_address is citywide-null, so bridge via REB road/jibun when available.
    const cand: PublicCoordRow[] = [];
    if (c.kapt_code && kaptIndex.has(c.kapt_code)) {
      cand.push(...(kaptIndex.get(c.kapt_code) || []));
    }
    if (roadKey && roadIndex.has(roadKey)) {
      cand.push(...(roadIndex.get(roadKey) || []));
    }
    if (jibunAddr && jibunIndex.has(jibunAddr)) {
      cand.push(...(jibunIndex.get(jibunAddr) || []));
    }
    if (rebHits.length > 0) {
      for (const rh of rebHits) {
        if (rh.road_key && roadIndex.has(rh.road_key)) {
          cand.push(...(roadIndex.get(rh.road_key) || []));
        }
        if (rh.jibun_addr && jibunIndex.has(rh.jibun_addr)) {
          cand.push(...(jibunIndex.get(rh.jibun_addr) || []));
        }
      }
    }
    const { status: coordStatus, hit } = pickCoord(cand);
    counts[coordStatus] = (counts[coordStatus] || 0) + 1;

    const gate =
      hit != null &&
      (coordStatus === "EXACT_OFFICIAL_ID" ||
        coordStatus === "EXACT_ROAD_ADDRESS" ||
        coordStatus === "EXACT_JIBUN_ADDRESS" ||
        coordStatus === "EXACT_PARCEL" ||
        coordStatus === "MULTI_RECORD_RESOLVED");

    results.push({
      complex_id: c.complex_id,
      apt_name: c.apt_name,
      sigungu: c.sigungu,
      our_jibun_addr: jibunAddr,
      our_road_addr: roadAddr,
      our_pnu0: pnu0,
      our_pnu_key: pnuKey,
      reb_status: rebStatus,
      reb_pnu: rebPnu,
      reb_id: rebId,
      coord_status: coordStatus,
      lat: hit?.lat ?? null,
      lng: hit?.lng ?? null,
      coord_source: hit?.source ?? null,
      coord_source_id: hit?.source_id ?? null,
      coord_method: hit?.method ?? null,
      gate_eligible: gate,
    });
  }

  // Sample: prefer diverse gu among gate-eligible + openapt sample matches + known districts
  const sampleTargets = [
    "강남구",
    "송파구",
    "종로구",
    "마포구",
    "강서구",
    "노원구",
    "서대문구",
    "도봉구",
    "동작구",
    "구로구",
  ];
  const samples: Result[] = [];
  for (const gu of sampleTargets) {
    const hit =
      results.find((r) => r.sigungu === gu && r.gate_eligible) ||
      results.find((r) => r.sigungu === gu && r.reb_status === "EXACT_PARCEL") ||
      results.find((r) => r.sigungu === gu);
    if (hit) samples.push(hit);
  }
  // add up to 40 unique
  for (const r of results) {
    if (samples.length >= 40) break;
    if (r.gate_eligible && !samples.some((s) => s.complex_id === r.complex_id)) {
      samples.push(r);
    }
  }

  const jam = results.find((r) => r.complex_id === JAMSIL_ELS_CANONICAL_CENTER.complexId);
  const jamDiff =
    jam?.lat != null && jam?.lng != null
      ? haversineMeters(
          jam.lat,
          jam.lng,
          JAMSIL_ELS_CANONICAL_CENTER.lat,
          JAMSIL_ELS_CANONICAL_CENTER.lng,
        )
      : null;

  const gateEligible = results.filter((r) => r.gate_eligible).length;
  const rebExact =
    (rebCounts["EXACT_PARCEL"] || 0) +
    (rebCounts["EXACT_JIBUN_ADDRESS"] || 0) +
    (rebCounts["MULTI_RECORD_SAME_PARCEL"] || 0);

  const summary = {
    mode: "dry-run",
    source_version: SOURCE_VERSION,
    generatedAt: new Date().toISOString(),
    production_coordinate_rows_written: 0,
    production_school_rows_written: 0,
    school_rerun: false,
    join_keys: {
      total: complexes.length,
      lawd: complexes.filter((c) => !!c.lawd_cd).length,
      dong_name: complexes.filter((c) => !!c.legal_dong_name).length,
      bjdong_cd: complexes.filter((c) => !!c.bjdong_cd).length,
      jibun: complexes.filter((c) => !!c.jibun).length,
      bun_ji_parseable: bunJiOk,
      road_address: complexes.filter((c) => !!c.road_address).length,
      kapt_links: complexes.filter((c) => !!c.kapt_code).length,
      building_hub_pnu: complexes.filter((c) => !!c.hub_pnu).length,
      pnu_plat0_composable: pnu0Ok,
      pnu_land_agnostic_key: pnuKeyOk,
      note: "platGb not stored on master; PNU uses platGb=0 (대지) for composable key; REB join uses land-agnostic key",
    },
    sources: [
      {
        name: "Seoul OpenAptInfo (OA-15818)",
        provider: "서울특별시 열린데이터광장",
        official: true,
        format: "OpenAPI JSON",
        bulk: "API pagination (not file bulk without key)",
        api_key: "SEOUL_OPENAPI_KEY required for >5 rows (sample key max 5)",
        available_keys: ["APT_CD", "APT_RDN_ADDR", "XCRD", "YCRD", "SGG_ADDR", "EMD_ADDR"],
        coordinate: true,
        coordinate_meaning: "XCRD/YCRD appear WGS84 lon/lat (verified sample bbox)",
        crs: "EPSG:4326 (observed)",
        version: "live API; sample pulled 2026-09-18",
        license: "공공누리 1유형 : 출처표시 (상업적 이용 및 변경 가능) — per OA-15818 page",
        attribution: "required (제1유형)",
        classification: process.env.SEOUL_OPENAPI_KEY?.trim()
          ? "PRIMARY CANDIDATE"
          : "PRIMARY CANDIDATE (KEY_REQUIRED)",
        coverage_records: process.env.SEOUL_OPENAPI_KEY?.trim()
          ? openAptFull.length
          : 5,
        reason: "Only citywide official apartment table found with coordinates + APT_CD",
      },
      {
        name: "한국부동산원 공동주택 단지 식별정보_기본정보",
        provider: "한국부동산원",
        official: true,
        format: "CSV bulk",
        bulk: true,
        api_key: "none for file download",
        available_keys: ["단지고유번호", "필지고유번호(PNU)", "주소", "도로명주소", "단지명"],
        coordinate: false,
        coordinate_meaning: "n/a",
        crs: "n/a",
        version: "20260831",
        license: "이용허락범위 제한 없음 (portal stated)",
        attribution: "UNKNOWN (not explicitly stated beyond unrestricted use)",
        classification: "SECONDARY CANDIDATE (identity/PNU only)",
        coverage_records_seoul: reb.length,
        reason: "Deterministic PNU join; does not itself supply coordinates",
      },
      {
        name: "서대문구/도봉구 공동주택 현황 CSV",
        provider: "자치구 → 공공데이터포털",
        official: true,
        format: "CSV",
        bulk: true,
        api_key: "none",
        available_keys: ["도로명주소/지번", "좌표 or 위도경도"],
        coordinate: true,
        coordinate_meaning: "UNKNOWN representative point",
        crs: "EPSG:4326 (observed WGS84)",
        version: "서대문 20220623 / 도봉 2018",
        license: "이용허락범위 제한 없음 (portal stated for downloaded files)",
        attribution: "UNKNOWN",
        classification: "FALLBACK ONLY",
        reason: "Coords present but gu-partial; not citywide",
      },
      {
        name: "연속지적도형정보 / LX 필지점 / 위치정보요약DB",
        provider: "국토교통부 / LX / 행정안전부",
        official: true,
        format: "SHP/TXT via VWorld or juso application",
        bulk: true,
        api_key: "VWorld login or juso application (KEY_REQUIRED / APPLICATION_REQUIRED)",
        coordinate: true,
        coordinate_meaning: "parcel polygon / parcel point / building entrance",
        crs: "EPSG:5186 or EPSG:5179 (per dataset)",
        version: "UNKNOWN (not downloaded)",
        license: "varies (daily 연속지적: 제한 없음; some LX/nationwide: 제4유형 commercial prohibited)",
        attribution: "UNKNOWN/dataset-specific",
        classification: "SECONDARY CANDIDATE (blocked this run)",
        reason: "Best parcel-centroid path but download gated; not fetched",
      },
      {
        name: "NAVER geocode / VWorld geocode / Nominatim",
        classification: "REJECT for this order",
        reason: "NAVER 401; VWorld key absent; Nominatim low-confidence pilot only",
      },
    ],
    reb_identity_join: {
      total: complexes.length,
      ...rebCounts,
      high_confidence_identity: rebExact,
      high_confidence_identity_pct: Number(((100 * rebExact) / complexes.length).toFixed(2)),
    },
    coordinate_join: {
      total: complexes.length,
      ...counts,
      gate_eligible: gateEligible,
      high_confidence_coverage_pct: Number(((100 * gateEligible) / complexes.length).toFixed(4)),
      openapt_full_loaded: openAptFull.length,
      gu_and_sample_coord_rows: guCoords.length,
      seoul_openapi_key_present: Boolean(process.env.SEOUL_OPENAPI_KEY?.trim()),
    },
    sample: {
      sample_total: samples.length,
      rows: samples.slice(0, 40).map((s) => ({
        complex_id: s.complex_id,
        apt_name: s.apt_name,
        sigungu: s.sigungu,
        our_key: s.our_pnu_key || s.our_jibun_addr,
        reb_status: s.reb_status,
        reb_pnu: s.reb_pnu,
        coordinate: s.lat != null ? { lat: s.lat, lng: s.lng } : null,
        coord_source: s.coord_source,
        method: s.coord_method,
        status: s.coord_status,
      })),
    },
    jamsil_els: {
      complex_id: JAMSIL_ELS_CANONICAL_CENTER.complexId,
      known_anchor: {
        lat: JAMSIL_ELS_CANONICAL_CENTER.lat,
        lng: JAMSIL_ELS_CANONICAL_CENTER.lng,
      },
      reb_status: jam?.reb_status ?? null,
      reb_pnu: jam?.reb_pnu ?? null,
      our_pnu0: jam?.our_pnu0 ?? null,
      our_hub_pnu: complexes.find((c) => c.complex_id === jam?.complex_id)?.hub_pnu ?? null,
      candidate: jam?.lat != null ? { lat: jam.lat, lng: jam.lng } : null,
      difference_meters: jamDiff,
      coord_status: jam?.coord_status ?? null,
      note: "Official OpenAptInfo coordinate for 잠실엘스 not fetched (SEOUL_OPENAPI_KEY absent); REB PNU identity matched",
    },
    unresolved_coord: {
      total: complexes.length - gateEligible,
      no_match: counts["NO_MATCH"] || 0,
      ambiguous: counts["AMBIGUOUS"] || 0,
      invalid: (counts["INVALID_SOURCE_COORD"] || 0) + (counts["INVALID_COORD"] || 0),
      primary_blocker: "SEOUL_OPENAPI_KEY absent — citywide OpenAptInfo coordinates unavailable",
    },
    operations: {
      external_geocoder: false,
      network_geocode_calls: 0,
      bulk_downloads: [
        {
          id: "15106861",
          name: "REB complex identity basic",
          sha256: sha256File(join(CACHE, "downloads/15106861_0.bin")),
        },
        {
          id: "15055494",
          name: "Seodaemun apt status",
          sha256: sha256File(join(CACHE, "downloads/15055494.bin")),
        },
        {
          id: "15028125",
          name: "Dobong apt status 2018",
          sha256: sha256File(join(CACHE, "downloads/15028125.bin")),
        },
      ],
      api_calls: {
        openaptinfo_sample: 1,
        openaptinfo_full: openAptFull.length ? "cached_or_paginated" : 0,
      },
      api_key_required_for_citywide_coords: true,
      pc_required: false,
      deterministic_rerun: true,
    },
  };

  writeFileSync(join(OUT, "coordinate-source-report.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(OUT, "coordinate-source-sample.json"),
    JSON.stringify({ samples: summary.sample.rows, jamsil_els: summary.jamsil_els }, null, 2),
  );

  const unresolved = results.filter((r) => !r.gate_eligible);
  const csv = [
    "complex_id,apt_name,sigungu,coord_status,reb_status,our_pnu_key,our_jibun_addr",
    ...unresolved.map((r) =>
      [
        r.complex_id,
        JSON.stringify(r.apt_name),
        r.sigungu ?? "",
        r.coord_status,
        r.reb_status,
        r.our_pnu_key ?? "",
        JSON.stringify(r.our_jibun_addr ?? ""),
      ].join(","),
    ),
  ].join("\n");
  writeFileSync(join(OUT, "coordinate-source-unresolved.csv"), csv);

  // compact candidates for gate-eligible only
  writeFileSync(
    join(OUT, "coordinate-source-gate-overrides.json"),
    JSON.stringify(
      {
        source_version: SOURCE_VERSION,
        count: gateEligible,
        overrides: Object.fromEntries(
          results
            .filter((r) => r.gate_eligible && r.lat != null && r.lng != null)
            .map((r) => [
              r.complex_id,
              { lat: r.lat, lng: r.lng, source: r.coord_source, method: r.coord_method },
            ]),
        ),
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        out: OUT,
        total: complexes.length,
        reb_identity_high_conf: rebExact,
        coord_gate_eligible: gateEligible,
        seoul_openapi_key: Boolean(process.env.SEOUL_OPENAPI_KEY?.trim()),
        jamsil_reb: jam?.reb_status,
        jamsil_coord: jam?.coord_status,
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
