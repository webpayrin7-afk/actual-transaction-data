/**
 * Assignment product-readiness audit (research only).
 * No Production assignment table writes.
 *
 *   npx tsx scripts/school-assignment-readiness-audit.ts
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { isDatasetAbsent } from "../src/lib/school-national/parse";

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

function loadCsv(filePath: string): Record<string, string>[] {
  const raw = readFileSync(filePath);
  let text = "";
  for (const enc of ["utf-8-sig", "utf-8", "cp949"] as const) {
    try {
      text = new TextDecoder(enc).decode(raw);
      break;
    } catch {
      // continue
    }
  }
  if (!text) throw new Error(`decode failed: ${filePath}`);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKC")
    // SchoolInfo often appends ", 학교명 (동)" after the road line.
    .replace(/\([^)]*\)/g, "")
    .replace(/,.*$/g, "")
    .replace(/\s+/g, "")
    .replace(/[·•]/g, "")
    .toLowerCase();
}

/** Dong-only parcels like "서울특별시 송파구 신천동" are not unique enough. */
function isSpecificParcel(raw: string | null | undefined): boolean {
  const normalized = normalizeAddress(raw);
  if (!normalized) return false;
  return /\d/.test(normalized);
}

function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function levelOf(raw: string): "elementary" | "middle" | "high" | null {
  if (raw.includes("초")) return "elementary";
  if (raw.includes("중")) return "middle";
  if (raw.includes("고")) return "high";
  return null;
}

type MappingClass =
  | "EXACT_OFFICIAL_CODE"
  | "EXACT_MULTI_FIELD"
  | "HISTORICAL_ALIAS"
  | "AMBIGUOUS"
  | "NO_MATCH";

type KoiesSchool = {
  id: string;
  name: string;
  level: "elementary" | "middle" | "high";
  road: string;
  parcel: string;
  office: string;
  support: string;
  lat: number | null;
  lng: number | null;
  sido: string;
};

type SchoolInfoSchool = {
  code: string;
  name: string;
  level: "elementary" | "middle" | "high";
  road: string;
  parcel: string;
  sido: string;
  sigungu: string;
  lat: number | null;
  lng: number | null;
  status: string;
};

function regionBucket(sido: string): "seoul" | "gyeonggi" | "other" {
  if (sido.startsWith("서울")) return "seoul";
  if (sido.startsWith("경기")) return "gyeonggi";
  return "other";
}

async function loadSchoolInfo(db: Client): Promise<SchoolInfoSchool[]> {
  const res = await db.execute(`
    SELECT school_code, school_name, school_level, road_address, address, sido, sigungu, lat, lng, status
    FROM school_master
  `);
  return res.rows.map((row) => ({
    code: String(row.school_code),
    name: String(row.school_name ?? ""),
    level: String(row.school_level) as SchoolInfoSchool["level"],
    road: String(row.road_address ?? ""),
    parcel: String(row.address ?? ""),
    sido: String(row.sido ?? ""),
    sigungu: String(row.sigungu ?? ""),
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    status: String(row.status ?? ""),
  }));
}

function buildCrosswalk(koies: KoiesSchool[], schoolInfo: SchoolInfoSchool[]) {
  const byRoad = new Map<string, SchoolInfoSchool[]>();
  const byParcel = new Map<string, SchoolInfoSchool[]>();
  const byNameLevel = new Map<string, SchoolInfoSchool[]>();
  for (const school of schoolInfo) {
    const roadKey = `${school.level}|${normalizeAddress(school.road)}`;
    const parcelKey = `${school.level}|${normalizeAddress(school.parcel)}`;
    const nameKey = `${school.level}|${normalizeName(school.name)}`;
    if (normalizeAddress(school.road)) {
      const list = byRoad.get(roadKey) ?? [];
      list.push(school);
      byRoad.set(roadKey, list);
    }
    if (isSpecificParcel(school.parcel)) {
      const list = byParcel.get(parcelKey) ?? [];
      list.push(school);
      byParcel.set(parcelKey, list);
    }
    const list = byNameLevel.get(nameKey) ?? [];
    list.push(school);
    byNameLevel.set(nameKey, list);
  }

  const results: Array<{
    koiesId: string;
    name: string;
    level: string;
    region: string;
    classification: MappingClass;
    schoolCode: string | null;
    evidence: string;
  }> = [];

  let exactCode = 0;
  let exactMulti = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let historical = 0;

  for (const school of koies) {
    const roadKey = `${school.level}|${normalizeAddress(school.road)}`;
    const parcelKey = `${school.level}|${normalizeAddress(school.parcel)}`;
    const roadHits = normalizeAddress(school.road) ? byRoad.get(roadKey) ?? [] : [];
    const parcelHits = isSpecificParcel(school.parcel) ? byParcel.get(parcelKey) ?? [] : [];

    // Prefer unique road match. Parcel is fallback only when specific and unique.
    if (roadHits.length === 1) {
      const hit = roadHits[0]!;
      const sameName = normalizeName(hit.name) === normalizeName(school.name);
      results.push({
        koiesId: school.id,
        name: school.name,
        level: school.level,
        region: regionBucket(school.sido || hit.sido),
        classification: "EXACT_MULTI_FIELD",
        schoolCode: hit.code,
        evidence: `level+road_address${sameName ? "+name" : ""}`,
      });
      exactMulti += 1;
      continue;
    }
    if (roadHits.length > 1) {
      results.push({
        koiesId: school.id,
        name: school.name,
        level: school.level,
        region: regionBucket(school.sido),
        classification: "AMBIGUOUS",
        schoolCode: null,
        evidence: `road candidates ${roadHits.map((c) => c.code).join(",")}`,
      });
      ambiguous += 1;
      continue;
    }
    if (parcelHits.length === 1) {
      const hit = parcelHits[0]!;
      const sameName = normalizeName(hit.name) === normalizeName(school.name);
      results.push({
        koiesId: school.id,
        name: school.name,
        level: school.level,
        region: regionBucket(school.sido || hit.sido),
        classification: "EXACT_MULTI_FIELD",
        schoolCode: hit.code,
        evidence: `level+specific_parcel_address${sameName ? "+name" : ""}`,
      });
      exactMulti += 1;
      continue;
    }
    if (parcelHits.length > 1) {
      results.push({
        koiesId: school.id,
        name: school.name,
        level: school.level,
        region: regionBucket(school.sido),
        classification: "AMBIGUOUS",
        schoolCode: null,
        evidence: `parcel candidates ${parcelHits.map((c) => c.code).join(",")}`,
      });
      ambiguous += 1;
      continue;
    }

    // Name-only is never enough. If name+level hits many or one, still NO_MATCH / AMBIGUOUS without address.
    const nameHits = byNameLevel.get(`${school.level}|${normalizeName(school.name)}`) ?? [];
    if (nameHits.length > 1) {
      results.push({
        koiesId: school.id,
        name: school.name,
        level: school.level,
        region: regionBucket(school.sido),
        classification: "AMBIGUOUS",
        schoolCode: null,
        evidence: "name+level only, multiple SchoolInfo codes; not public-safe",
      });
      ambiguous += 1;
      continue;
    }
    results.push({
      koiesId: school.id,
      name: school.name,
      level: school.level,
      region: regionBucket(school.sido),
      classification: "NO_MATCH",
      schoolCode: null,
      evidence: nameHits.length === 1
        ? `name+level only to ${nameHits[0]!.code}; rejected (name-only insufficient)`
        : "no shared official address",
    });
    unmatched += 1;
  }

  void exactCode;
  void historical;
  return { results, exactCode, exactMulti, ambiguous, unmatched, historical };
}

async function audit2027(db: Client): Promise<Record<string, unknown>> {
  const key = process.env.SCHOOLINFO_API_KEY?.trim();
  if (!key) throw new Error("SCHOOLINFO_API_KEY missing");

  async function fetchScope(year: string, sido: string, sgg: string, kind: string) {
    const url = new URL("https://www.schoolinfo.go.kr/openApi.do");
    url.searchParams.set("apiKey", key);
    url.searchParams.set("apiType", "0");
    url.searchParams.set("schulKndCode", kind);
    url.searchParams.set("sidoCode", sido);
    url.searchParams.set("sggCode", sgg);
    url.searchParams.set("pbanYr", year);
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "ziplab-school-detail/1.0" },
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json()) as { resultCode?: string; resultMsg?: string; list?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.list) ? body.list : [];
    const absent = isDatasetAbsent(body.resultCode ?? null, body.resultMsg ?? null);
    return {
      year,
      sido,
      sgg,
      kind,
      http: res.status,
      resultCode: body.resultCode ?? null,
      resultMsg: body.resultMsg ?? null,
      absent,
      rows: list.length,
      sample: list.slice(0, 3).map((row) => ({
        code: row.SCHUL_CODE,
        name: row.SCHUL_NM,
        close: row.CLOSE_YN,
        fond: row.FOND_YMD,
        road: row.SCHUL_RDNMA,
        lat: row.LTTUD,
        lng: row.LGTUD,
        pban: row.PBAN_YR,
      })),
      codes: list.map((row) => String(row.SCHUL_CODE ?? "")).filter(Boolean).sort(),
    };
  }

  const scopes = [
    { label: "songpa_middle", sido: "11", sgg: "11710", kind: "03" },
    { label: "songpa_elementary", sido: "11", sgg: "11710", kind: "02" },
    { label: "songpa_high", sido: "11", sgg: "11710", kind: "04" },
    { label: "busan_jung_middle", sido: "26", sgg: "26110", kind: "03" },
  ];
  const comparisons: Record<string, unknown> = {};
  for (const scope of scopes) {
    const y2026 = await fetchScope("2026", scope.sido, scope.sgg, scope.kind);
    const y2027 = await fetchScope("2027", scope.sido, scope.sgg, scope.kind);
    const set2026 = new Set(y2026.codes);
    const set2027 = new Set(y2027.codes);
    const only2026 = y2026.codes.filter((c) => !set2027.has(c));
    const only2027 = y2027.codes.filter((c) => !set2026.has(c));
    comparisons[scope.label] = {
      y2026_rows: y2026.rows,
      y2027_rows: y2027.rows,
      only_2026: only2026,
      only_2027: only2027,
      sample_2026: y2026.sample,
      sample_2027: y2027.sample,
      result_2027: { code: y2027.resultCode, msg: y2027.resultMsg, absent: y2027.absent },
    };
  }

  // Pilot schools explicit
  async function schoolYears(code: string, nameHint: string) {
    // use Songpa middle feed rows already; also probe by filtering national? openApi is district scoped.
    return { code, nameHint };
  }
  await schoolYears("S010000888", "잠실중");

  const pointer = await db.execute(`
    SELECT category, loaded_year, candidate_year, candidate_status
    FROM school_category_year ORDER BY category
  `);
  return {
    documentation_note:
      "SchoolInfo openApi.do requires pbanYr. Rows often omit PBAN_YR on BASIC. Official SchoolInfo help treats pbanYr as 공시년도 (disclosure year), not an academic-year enrollment promise. 2027 returns live BASIC rows for current districts before all categories publish together.",
    comparisons,
    category_years: pointer.rows,
    pointer_recommendation:
      "Keep current pointer on the latest COMPLETE officially-effective disclosure year that is fully loaded for the category. Do not switch BASIC to MAX(year)=2027 until a controlled incremental load proves category completeness and product semantics. Candidate 2027 is recorded only.",
    pointer_changed: false,
  };
}

async function nearbyDeltaCount(db: Client): Promise<Record<string, unknown>> {
  const ready = await db.execute(`
    SELECT COUNT(*) AS n
    FROM apt_complex_master c
    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
      AND c.identity_status = 'IDENTITY-READY'
      AND NOT EXISTS (
        SELECT 1 FROM complex_nearby_materialization m WHERE m.complex_id = c.complex_id
      )
  `);
  const totalCoord = await db.execute(`
    SELECT COUNT(*) AS n FROM apt_complex_master
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND identity_status = 'IDENTITY-READY'
  `);
  const materialized = await db.execute(`SELECT COUNT(*) AS n FROM complex_nearby_materialization`);
  return {
    identity_ready_with_coord: Number(totalCoord.rows[0]?.n ?? 0),
    materialized: Number(materialized.rows[0]?.n ?? 0),
    pending_delta_only_count: Number(ready.rows[0]?.n ?? 0),
    note: "Count only. No nearby rematerialization in this run.",
  };
}

async function excludedAudit(db: Client): Promise<Record<string, unknown>> {
  const codes = ["S090005579", "S090005676", "S090006652", "S090007522"];
  const out = [];
  for (const code of codes) {
    const master = await db.execute({
      sql: "SELECT school_code, school_name, sido, sgg_code FROM school_master WHERE school_code = ?",
      args: [code],
    });
    const grad = await db.execute({
      sql: `SELECT json_extract(raw_json,'$.SCHUL_NM') name,
                   json_extract(raw_json,'$.ADRCD_NM') adrcd,
                   json_extract(raw_json,'$.ADRCD_CD') adrcd_cd,
                   json_extract(raw_json,'$.ATPT_OFCDC_ORG_NM') office
            FROM school_detail_snapshots
            WHERE school_code = ? AND category = 'GRADUATE_PATH' LIMIT 1`,
      args: [code],
    });
    out.push({
      school_code: code,
      in_master: master.rows.length > 0,
      graduate: grad.rows[0] ?? null,
      decision: master.rows.length > 0 ? "RECOVERED" : "EXCLUDED_IDENTITY_INCOMPLETE",
    });
  }
  return { recovered: out.filter((r) => r.in_master).length, remaining: out.filter((r) => !r.in_master).length, rows: out };
}

async function main(): Promise<void> {
  const locPath = "/tmp/koies/loc_zip/한국교육시설안전원_초중등학교위치_20260320.csv";
  const linkPath = "/tmp/koies/link_zip/한국교육시설안전원_학교학구도연계정보_20260320.csv";
  if (!existsSync(locPath) || !existsSync(linkPath)) throw new Error("KOIES files missing under /tmp/koies");

  const db = dbClient();
  const koiesRows = loadCsv(locPath);
  const linkRows = loadCsv(linkPath);
  const koies: KoiesSchool[] = koiesRows.map((row) => {
    const level = levelOf(row["학교급구분"] ?? "");
    if (!level) throw new Error(`bad level ${row["학교급구분"]}`);
    const sido = (row["소재지도로명주소"] || row["소재지지번주소"] || "").split(/\s+/)[0] ?? "";
    return {
      id: row["학교ID"] ?? "",
      name: row["학교명"] ?? "",
      level,
      road: row["소재지도로명주소"] ?? "",
      parcel: row["소재지지번주소"] ?? "",
      office: row["시도교육청명"] ?? "",
      support: row["교육지원청명"] ?? "",
      lat: row["위도"] ? Number(row["위도"]) : null,
      lng: row["경도"] ? Number(row["경도"]) : null,
      sido,
    };
  }).filter((row) => row.id);

  const schoolInfo = await loadSchoolInfo(db);
  const crosswalk = buildCrosswalk(koies, schoolInfo);

  function coverage(filterLevel?: string, filterRegion?: string) {
    const subset = crosswalk.results.filter((row) => {
      if (filterLevel && row.level !== filterLevel) return false;
      if (filterRegion && row.region !== filterRegion) return false;
      return true;
    });
    const koiesN = subset.length;
    const mapped = subset.filter((r) => r.classification === "EXACT_MULTI_FIELD" || r.classification === "EXACT_OFFICIAL_CODE").length;
    const amb = subset.filter((r) => r.classification === "AMBIGUOUS").length;
    const un = subset.filter((r) => r.classification === "NO_MATCH").length;
    const schoolInfoN = schoolInfo.filter((s) => {
      if (filterLevel && s.level !== filterLevel) return false;
      if (filterRegion && regionBucket(s.sido) !== filterRegion) return false;
      return true;
    }).length;
    return {
      koies_schools: koiesN,
      schoolinfo_schools: schoolInfoN,
      exact_mapped: mapped,
      ambiguous: amb,
      unmatched: un,
      coverage_pct: koiesN ? Math.round((mapped / koiesN) * 1000) / 10 : 0,
    };
  }

  const rightsPath = "/tmp/koies/standard.txt";
  const rightsText = existsSync(rightsPath) ? readFileSync(rightsPath, "utf8") : "";
  const rightsHit = /공공누리|이용허락|제[0-4]유형|상업적|KOGL/i.test(rightsText);

  const report = {
    generated_at: new Date().toISOString(),
    rights: {
      publisher: "한국교육시설안전원 (KOIES)",
      datasets: [
        { id: "15021148", name: "전국초중등학교위치표준데이터", version: "2026-03-20" },
        { id: "15021149", name: "전국초등학교통학구역표준데이터", version: "2026-03-20" },
        { id: "15021151", name: "전국중학교학교군표준데이터", version: "2026-03-20" },
        { id: "15021153", name: "전국고등학교학교군표준데이터", version: "2026-03-20" },
        { id: "15021158", name: "전국학교학구도연계정보표준데이터", version: "2026-03-20" },
      ],
      schoolzone: "https://schoolzone.emac.kr/publicData/dataInfo.do",
      cadence: "March and September",
      standard_pdf_mentions_kogl: rightsHit,
      commercial_use: "UNKNOWN",
      redistribution: "UNKNOWN",
      modification: "UNKNOWN",
      attribution: "UNKNOWN — publisher identity is clear (KOIES / data.go.kr), but no KOGL type mark was found on the dataset pages or the 2026-03-20 standard PDF extract",
      unresolved: "No explicit 공공누리/KOGL type, commercial-use, modification, or redistribution clause found on the fetched portal pages or standard PDF text. SchoolInfo 제3유형 must not be assumed for KOIES polygons.",
      verdict: "RIGHTS_UNKNOWN",
    },
    crosswalk: {
      method: "Deterministic level + exact normalized road/parcel address unique match. Name-only rejected. No shared official school code field between KOIES 학교ID (B…) and SchoolInfo SCHUL_CODE (S…). EXACT_OFFICIAL_CODE = 0.",
      exact_official_code: crosswalk.exactCode,
      exact_multi_field: crosswalk.exactMulti,
      ambiguous: crosswalk.ambiguous,
      unmatched: crosswalk.unmatched,
      national: {
        elementary: coverage("elementary"),
        middle: coverage("middle"),
        high: coverage("high"),
        all: coverage(),
      },
      seoul: {
        elementary: coverage("elementary", "seoul"),
        middle: coverage("middle", "seoul"),
        high: coverage("high", "seoul"),
        all: coverage(undefined, "seoul"),
      },
      gyeonggi: {
        elementary: coverage("elementary", "gyeonggi"),
        middle: coverage("middle", "gyeonggi"),
        high: coverage("high", "gyeonggi"),
        all: coverage(undefined, "gyeonggi"),
      },
      linkage_rows: linkRows.length,
      sample_mapped: crosswalk.results.filter((r) => r.classification === "EXACT_MULTI_FIELD").slice(0, 10),
      sample_unmatched: crosswalk.results.filter((r) => r.classification === "NO_MATCH").slice(0, 10),
    },
    year_2027: await audit2027(db),
    nearby_pending: await nearbyDeltaCount(db),
    excluded: await excludedAudit(db),
    assignment_writes: 0,
  };

  const outDir = path.join(process.cwd(), "data/poc/school-national");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "assignment-readiness-audit.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    path.join(outDir, "koies-schoolinfo-crosswalk-sample.json"),
    JSON.stringify({
      mapped: crosswalk.results.filter((r) => r.classification === "EXACT_MULTI_FIELD").slice(0, 100),
      ambiguous: crosswalk.results.filter((r) => r.classification === "AMBIGUOUS").slice(0, 50),
      unmatched: crosswalk.results.filter((r) => r.classification === "NO_MATCH").slice(0, 50),
    }, null, 2),
  );
  console.log(JSON.stringify({
    rights: report.rights.verdict,
    exact_multi: crosswalk.exactMulti,
    ambiguous: crosswalk.ambiguous,
    unmatched: crosswalk.unmatched,
    national_coverage_pct: report.crosswalk.national.all.coverage_pct,
    seoul_pct: report.crosswalk.seoul.all.coverage_pct,
    gyeonggi_pct: report.crosswalk.gyeonggi.all.coverage_pct,
    pending_nearby: report.nearby_pending,
    excluded: report.excluded.remaining,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
