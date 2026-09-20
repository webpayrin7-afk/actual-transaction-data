/**
 * National school master + category snapshots + nearby links.
 *
 * Source: 학교알리미 SchoolInfo (openApi.do + openData.do apiType 52).
 * Canonical key: SchoolInfo SCHUL_CODE. Names are never an identity.
 * Assignment / attendance zones are not loaded.
 *
 *   npx tsx scripts/school-national-backfill.ts --write
 *   npx tsx scripts/school-national-backfill.ts --write --sido=11 --sgg=11710
 *   npx tsx scripts/school-national-backfill.ts --report-only
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import lawdRows from "../src/lib/constants/nationwide-lawd.json";
import {
  DISTANCE_BASIS,
  NEARBY_CLASSIFICATION,
  NEARBY_RADIUS_M,
  SCHOOLINFO_ATTRIBUTION,
  SCHOOLINFO_LICENSE,
  VERIFIED_NEIS_LINKS,
  afterSchoolCategoryStatus,
  basicCategoryStatus,
  graduateCategoryStatus,
  haversineMeters,
  isDatasetAbsent,
  levelFromKindCode,
  mealCategoryStatus,
  parseAfterSchool,
  parseBasic,
  parseHighGraduate,
  parseMeal,
  parseMiddleGraduate,
  parseScholarship,
  parseStudents,
  parseTeachers,
  scholarshipCategoryStatus,
  schoolCodeOf,
  studentCategoryStatus,
  teacherCategoryStatus,
  type CategoryStatus,
  type SchoolLevel,
} from "../src/lib/school-national/parse";
import { masterWriteAction, rollupSchool } from "../src/lib/school-national/policy";

const OPEN_API = "https://www.schoolinfo.go.kr/openApi.do";
const OPEN_DATA = "https://www.schoolinfo.go.kr/openData.do";
const SOURCE = "schoolinfo";
const PREFERRED_YEAR = "2026";
const FALLBACK_YEAR = "2025";
const GRADUATE_YEAR = "2025";
const WRITE_TABLES = [
  "school_master",
  "school_detail_snapshots",
  "school_data_status",
  "school_fetch_checkpoint",
  "complex_nearby_schools",
];
const CATEGORIES = [
  "BASIC",
  "STUDENT",
  "TEACHER",
  "MEAL",
  "AFTERSCHOOL",
  "SCHOLARSHIP",
  "GRADUATE_PATH",
] as const;
type Category = (typeof CATEGORIES)[number];

const API_CATEGORY: Record<Exclude<Category, "GRADUATE_PATH">, { apiType: string; depthNo?: string }> = {
  BASIC: { apiType: "0" },
  STUDENT: { apiType: "09" },
  TEACHER: { apiType: "22" },
  MEAL: { apiType: "35", depthNo: "20" },
  AFTERSCHOOL: { apiType: "59" },
  SCHOLARSHIP: { apiType: "55" },
};

const KINDS: { level: SchoolLevel; code: string }[] = [
  { level: "elementary", code: "02" },
  { level: "middle", code: "03" },
  { level: "high", code: "04" },
];

const PRIORITY = ["11", "41", "28", "26", "27", "30", "29", "31", "36", "42", "43", "44", "45", "46", "47", "48", "50"];

type Lawd = { code: string; fullName: string };
type Row = Record<string, unknown>;

const stats = {
  calls: 0,
  reused: 0,
  retries: 0,
  rateLimits: 0,
  failures: 0,
  masterInserts: 0,
  masterUpdates: 0,
  masterSkips: 0,
  masterConflicts: 0,
  snapshotInserts: 0,
  snapshotSkips: 0,
  statusWrites: 0,
  nearbyInserts: 0,
  nearbySkips: 0,
  missingSchoolCode: 0,
};

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertSchoolWrite(sql: string): void {
  const compact = sql.replace(/\s+/g, " ").trim().toLowerCase();
  const okHead =
    compact.startsWith("insert") ||
    compact.startsWith("update") ||
    compact.startsWith("create") ||
    compact.startsWith("delete from complex_nearby_schools");
  if (!okHead) throw new Error(`refusing SQL: ${compact.slice(0, 80)}`);
  if (!WRITE_TABLES.some((t) => compact.includes(t))) {
    throw new Error("refusing write outside school tables");
  }
  const banned = ["transactions", "apt_", "ranking", "mgmt_fee", "complex_building", "market_"];
  for (const token of banned) {
    if (compact.includes(token)) throw new Error(`refusing unrelated write (${token})`);
  }
}

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

async function applySchema(db: Client): Promise<void> {
  const sqlPath = path.join(process.cwd(), "src/lib/db/migrations/20260920_school_national_v1.sql");
  const sql = readFileSync(sqlPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = sql.split(";").map((part) => part.trim()).filter(Boolean);
  for (const statement of statements) {
    assertSchoolWrite(statement);
    await db.execute(statement);
  }
}

class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

const limiter = new Limiter(4);

type FetchKind = "ok" | "empty" | "failed";
type FetchOutcome = {
  kind: FetchKind;
  rows: Row[];
  httpStatus: number;
  resultCode: string | null;
  attempts: number;
  retries: number;
  rateLimits: number;
};

function isSuccess(code: string | null, rows: unknown): boolean {
  const c = (code ?? "").toLowerCase();
  return (c === "success" || c === "info-000" || (c === "" && Array.isArray(rows))) && Array.isArray(rows);
}

async function fetchJson(url: string): Promise<FetchOutcome> {
  let attempts = 0;
  let retries = 0;
  let rateLimits = 0;
  let httpStatus = 0;
  let resultCode: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    attempts += 1;
    if (attempt > 0) retries += 1;
    try {
      const res = await limiter.run(() =>
        fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "ziplab-school-detail/1.0",
          },
          signal: AbortSignal.timeout(60_000),
        }),
      );
      stats.calls += 1;
      httpStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429) rateLimits += 1;
        if (attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        stats.retries += retries;
        stats.rateLimits += rateLimits;
        stats.failures += 1;
        return { kind: "failed", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
      }
      const body = (await res.json()) as { resultCode?: string; resultMsg?: string; list?: Row[] };
      resultCode = body.resultCode != null ? String(body.resultCode) : null;
      const list = Array.isArray(body.list) ? body.list : [];
      if (isDatasetAbsent(resultCode, body.resultMsg ?? null)) {
        stats.retries += retries;
        stats.rateLimits += rateLimits;
        return { kind: "empty", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
      }
      if (isSuccess(resultCode, body.list) && list.length > 0) {
        stats.retries += retries;
        stats.rateLimits += rateLimits;
        return { kind: "ok", rows: list, httpStatus, resultCode, attempts, retries, rateLimits };
      }
      if (isSuccess(resultCode, body.list)) {
        stats.retries += retries;
        stats.rateLimits += rateLimits;
        return { kind: "empty", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
      }
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      stats.retries += retries;
      stats.rateLimits += rateLimits;
      stats.failures += 1;
      return { kind: "failed", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
    } catch {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      stats.retries += retries;
      stats.rateLimits += rateLimits;
      stats.failures += 1;
      return { kind: "failed", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
    }
  }
  stats.failures += 1;
  return { kind: "failed", rows: [], httpStatus, resultCode, attempts, retries, rateLimits };
}

function scopeKey(year: string, sgg: string, kind: string, category: string): string {
  return `${year}|${sgg}|${kind}|${category}`;
}

async function checkpointStatus(db: Client, key: string): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT status FROM school_fetch_checkpoint WHERE scope_key = ?",
    args: [key],
  });
  return res.rows[0] ? String(res.rows[0].status) : null;
}

async function runBatch(db: Client, statements: InStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 40) {
    const chunk = statements.slice(i, i + 40);
    for (const statement of chunk) assertSchoolWrite(statement.sql);
    const results = await db.batch(chunk, "write");
    results.forEach((result, index) => {
      const sql = chunk[index]!.sql;
      const affected = Number(result.rowsAffected ?? 0);
      if (sql.includes("INSERT INTO school_master")) stats.masterInserts += affected;
      else if (sql.includes("UPDATE school_master")) stats.masterUpdates += affected;
      else if (sql.includes("INSERT INTO school_detail_snapshots")) {
        if (affected > 0) stats.snapshotInserts += affected;
        else stats.snapshotSkips += 1;
      } else if (sql.includes("INSERT INTO complex_nearby_schools")) {
        if (affected > 0) stats.nearbyInserts += affected;
        else stats.nearbySkips += 1;
      }
    });
  }
}

function checkpointStmt(
  key: string,
  status: string,
  year: string,
  category: string,
  outcome: FetchOutcome,
): InStatement {
  return {
    sql: `INSERT INTO school_fetch_checkpoint (
      scope_key, status, disclosure_year, category, http_status, result_code,
      row_count, attempts, retries, rate_limits, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      status = excluded.status,
      disclosure_year = excluded.disclosure_year,
      http_status = excluded.http_status,
      result_code = excluded.result_code,
      row_count = excluded.row_count,
      attempts = school_fetch_checkpoint.attempts + excluded.attempts,
      retries = school_fetch_checkpoint.retries + excluded.retries,
      rate_limits = school_fetch_checkpoint.rate_limits + excluded.rate_limits,
      updated_at = excluded.updated_at
    WHERE school_fetch_checkpoint.status = 'failed' OR excluded.status != 'failed'`,
    args: [
      key,
      status,
      year,
      category,
      outcome.httpStatus,
      outcome.resultCode,
      outcome.rows.length,
      outcome.attempts,
      outcome.retries,
      outcome.rateLimits,
      nowIso(),
    ],
  };
}

type MasterRow = {
  school_code: string;
  school_name: string;
  school_level: SchoolLevel;
  establishment_type: string | null;
  gender_type: string | null;
  sido: string | null;
  sigungu: string | null;
  sido_code: string;
  sgg_code: string;
  address: string | null;
  road_address: string | null;
  lat: number | null;
  lng: number | null;
  status: "operating" | "closed";
  source_as_of: string;
  neis_code: string | null;
};

function fingerprint(row: MasterRow): string {
  return JSON.stringify([
    row.school_name,
    row.school_level,
    row.establishment_type,
    row.gender_type,
    row.sido,
    row.sigungu,
    row.sido_code,
    row.sgg_code,
    row.address,
    row.road_address,
    row.lat,
    row.lng,
    row.status,
    row.neis_code,
  ]);
}

async function existingMasters(db: Client, codes: string[]): Promise<Map<string, { sourceAsOf: string; fingerprint: string }>> {
  const out = new Map<string, { sourceAsOf: string; fingerprint: string }>();
  for (let i = 0; i < codes.length; i += 80) {
    const slice = codes.slice(i, i + 80);
    const placeholders = slice.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT school_code, school_name, school_level, establishment_type, gender_type,
              sido, sigungu, sido_code, sgg_code, address, road_address, lat, lng, status,
              source_as_of, neis_code
            FROM school_master WHERE school_code IN (${placeholders})`,
      args: slice,
    });
    for (const raw of res.rows) {
      const row: MasterRow = {
        school_code: String(raw.school_code),
        school_name: String(raw.school_name),
        school_level: String(raw.school_level) as SchoolLevel,
        establishment_type: raw.establishment_type == null ? null : String(raw.establishment_type),
        gender_type: raw.gender_type == null ? null : String(raw.gender_type),
        sido: raw.sido == null ? null : String(raw.sido),
        sigungu: raw.sigungu == null ? null : String(raw.sigungu),
        sido_code: String(raw.sido_code ?? ""),
        sgg_code: String(raw.sgg_code ?? ""),
        address: raw.address == null ? null : String(raw.address),
        road_address: raw.road_address == null ? null : String(raw.road_address),
        lat: raw.lat == null ? null : Number(raw.lat),
        lng: raw.lng == null ? null : Number(raw.lng),
        status: String(raw.status) as "operating" | "closed",
        source_as_of: String(raw.source_as_of),
        neis_code: raw.neis_code == null ? null : String(raw.neis_code),
      };
      out.set(row.school_code, { sourceAsOf: row.source_as_of, fingerprint: fingerprint(row) });
    }
  }
  return out;
}

function masterInsert(row: MasterRow, at: string): InStatement {
  return {
    sql: `INSERT INTO school_master (
      school_code, school_name, school_level, establishment_type, gender_type,
      sido, sigungu, sido_code, sgg_code, address, road_address, lat, lng, status,
      source, source_as_of, neis_code, attribution, license_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.school_code,
      row.school_name,
      row.school_level,
      row.establishment_type,
      row.gender_type,
      row.sido,
      row.sigungu,
      row.sido_code,
      row.sgg_code,
      row.address,
      row.road_address,
      row.lat,
      row.lng,
      row.status,
      SOURCE,
      row.source_as_of,
      row.neis_code,
      SCHOOLINFO_ATTRIBUTION,
      SCHOOLINFO_LICENSE,
      at,
    ],
  };
}

function masterUpdate(row: MasterRow, at: string): InStatement {
  return {
    sql: `UPDATE school_master SET
      school_name = ?, school_level = ?, establishment_type = ?, gender_type = ?,
      sido = ?, sigungu = ?, sido_code = ?, sgg_code = ?, address = ?, road_address = ?,
      lat = ?, lng = ?, status = ?, source = ?, source_as_of = ?, neis_code = ?,
      attribution = ?, license_note = ?, updated_at = ?
      WHERE school_code = ? AND source_as_of < ?`,
    args: [
      row.school_name,
      row.school_level,
      row.establishment_type,
      row.gender_type,
      row.sido,
      row.sigungu,
      row.sido_code,
      row.sgg_code,
      row.address,
      row.road_address,
      row.lat,
      row.lng,
      row.status,
      SOURCE,
      row.source_as_of,
      row.neis_code,
      SCHOOLINFO_ATTRIBUTION,
      SCHOOLINFO_LICENSE,
      at,
      row.school_code,
      row.source_as_of,
    ],
  };
}

type ScopeSchool = { code: string; level: SchoolLevel; students: number | null };

async function loadScopeSchools(db: Client, sgg: string, level: SchoolLevel): Promise<ScopeSchool[]> {
  const res = await db.execute({
    sql: `SELECT m.school_code,
            (
              SELECT json_extract(s.parsed_json, '$.students.raw')
              FROM school_detail_snapshots s
              WHERE s.school_code = m.school_code AND s.category = 'STUDENT' AND s.source = ?
              ORDER BY s.disclosure_year DESC LIMIT 1
            ) AS students
          FROM school_master m
          WHERE m.sgg_code = ? AND m.school_level = ?`,
    args: [SOURCE, sgg, level],
  });
  return res.rows.map((row) => ({
    code: String(row.school_code),
    level,
    students: row.students == null ? null : Number(row.students),
  }));
}

function snapshotStmt(
  code: string,
  category: Category,
  year: string,
  status: CategoryStatus,
  parsed: unknown,
  raw: Row | null,
  at: string,
): InStatement {
  return {
    sql: `INSERT INTO school_detail_snapshots (
      school_code, category, disclosure_year, source, status, parsed_json, raw_json,
      attribution, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(school_code, category, disclosure_year, source) DO NOTHING`,
    args: [
      code,
      category,
      year,
      SOURCE,
      status,
      JSON.stringify(parsed),
      raw ? JSON.stringify(raw) : null,
      SCHOOLINFO_ATTRIBUTION,
      at,
    ],
  };
}

const STATUS_RANK: Record<CategoryStatus, number> = {
  FAILED: 0,
  NO_DATA: 1,
  NOT_APPLICABLE: 2,
  PARTIAL: 3,
  COMPLETE: 4,
};

async function existingStatuses(
  db: Client,
  codes: string[],
  category: Category,
): Promise<Map<string, { status: CategoryStatus; year: string }>> {
  const out = new Map<string, { status: CategoryStatus; year: string }>();
  for (let i = 0; i < codes.length; i += 80) {
    const slice = codes.slice(i, i + 80);
    const res = await db.execute({
      sql: `SELECT school_code, status, disclosure_year FROM school_data_status
            WHERE category = ? AND school_code IN (${slice.map(() => "?").join(",")})`,
      args: [category, ...slice],
    });
    for (const row of res.rows) {
      out.set(String(row.school_code), {
        status: String(row.status) as CategoryStatus,
        year: row.disclosure_year == null ? "" : String(row.disclosure_year),
      });
    }
  }
  return out;
}

function statusStmt(
  code: string,
  category: Category,
  status: CategoryStatus,
  year: string,
  detail: string,
  at: string,
): InStatement {
  return {
    sql: `INSERT INTO school_data_status (
      school_code, category, status, disclosure_year, detail, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(school_code, category) DO UPDATE SET
      status = excluded.status,
      disclosure_year = excluded.disclosure_year,
      detail = excluded.detail,
      updated_at = excluded.updated_at
    WHERE excluded.disclosure_year > COALESCE(school_data_status.disclosure_year, '')
      OR (
        excluded.disclosure_year = COALESCE(school_data_status.disclosure_year, '')
        AND excluded.status != school_data_status.status
        AND (
          CASE excluded.status
            WHEN 'COMPLETE' THEN 4 WHEN 'PARTIAL' THEN 3 WHEN 'NOT_APPLICABLE' THEN 2
            WHEN 'NO_DATA' THEN 1 ELSE 0 END
        ) > (
          CASE school_data_status.status
            WHEN 'COMPLETE' THEN 4 WHEN 'PARTIAL' THEN 3 WHEN 'NOT_APPLICABLE' THEN 2
            WHEN 'NO_DATA' THEN 1 ELSE 0 END
        )
      )`,
    args: [code, category, status, year, detail, at],
  };
}

function shouldWriteStatus(
  existing: { status: CategoryStatus; year: string } | undefined,
  incoming: CategoryStatus,
  year: string,
): boolean {
  if (!existing) return true;
  if (year > existing.year && STATUS_RANK[incoming] >= STATUS_RANK[existing.status]) return true;
  if (year === existing.year && STATUS_RANK[incoming] > STATUS_RANK[existing.status]) return true;
  if (year < existing.year) return false;
  return false;
}

function indexRows(rows: Row[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const row of rows) {
    const code = schoolCodeOf(row);
    if (!code) {
      stats.missingSchoolCode += 1;
      continue;
    }
    out.set(code, row);
  }
  return out;
}

function categoryPayload(
  category: Category,
  level: SchoolLevel,
  row: Row | null,
  students: number | null,
  datasetAbsent: boolean,
): { status: CategoryStatus; parsed: unknown } {
  if (category === "SCHOLARSHIP" && level === "elementary" && datasetAbsent) {
    return { status: "NOT_APPLICABLE", parsed: { applicability: "NOT_APPLICABLE" } };
  }
  if (!row) return { status: "NO_DATA", parsed: { applicability: "NO_DATA" } };
  if (category === "BASIC") {
    const parsed = parseBasic(row);
    return { status: basicCategoryStatus(parsed), parsed };
  }
  if (category === "STUDENT") {
    const parsed = parseStudents(row);
    return { status: studentCategoryStatus(parsed), parsed };
  }
  if (category === "TEACHER") {
    const parsed = parseTeachers(row);
    return { status: teacherCategoryStatus(parsed), parsed };
  }
  if (category === "MEAL") {
    const parsed = parseMeal(row);
    return { status: mealCategoryStatus(parsed), parsed };
  }
  if (category === "AFTERSCHOOL") {
    const parsed = parseAfterSchool(row);
    return { status: afterSchoolCategoryStatus(parsed), parsed };
  }
  if (category === "SCHOLARSHIP") {
    const parsed = parseScholarship(row, students);
    return { status: scholarshipCategoryStatus(parsed, "applies"), parsed };
  }
  const parsed = level === "high" ? parseHighGraduate(row) : parseMiddleGraduate(row);
  return { status: graduateCategoryStatus(level, parsed), parsed };
}

async function persistCategory(opts: {
  db: Client;
  category: Category;
  level: SchoolLevel;
  year: string;
  rows: Row[];
  schools: ScopeSchool[];
  region: { sido: string; sigungu: string; sidoCode: string; sggCode: string };
  datasetAbsent: boolean;
  outcome: FetchOutcome;
  scope: string;
}): Promise<void> {
  const at = nowIso();
  const byCode = indexRows(opts.rows);
  const statements: InStatement[] = [];
  const statusCodes = new Set<string>([...opts.schools.map((s) => s.code), ...byCode.keys()]);
  const prior = await existingStatuses(opts.db, [...statusCodes], opts.category);

  if (opts.category === "BASIC") {
    const masters: MasterRow[] = [];
    for (const [code, row] of byCode) {
      const parsed = parseBasic(row, { sido: opts.region.sido, sigungu: opts.region.sigungu });
      if (!parsed?.schoolCode || !parsed.name || !parsed.level) continue;
      masters.push({
        school_code: code,
        school_name: parsed.name,
        school_level: parsed.level,
        establishment_type: parsed.establishmentType,
        gender_type: parsed.genderType,
        sido: parsed.sido,
        sigungu: parsed.sigungu,
        sido_code: opts.region.sidoCode,
        sgg_code: opts.region.sggCode,
        address: parsed.address,
        road_address: parsed.roadAddress,
        lat: parsed.lat,
        lng: parsed.lng,
        status: parsed.status,
        source_as_of: opts.year,
        neis_code: VERIFIED_NEIS_LINKS[code] ?? null,
      });
    }
    const existing = await existingMasters(opts.db, masters.map((m) => m.school_code));
    for (const row of masters) {
      const action = masterWriteAction(existing.get(row.school_code) ?? null, {
        sourceAsOf: row.source_as_of,
        fingerprint: fingerprint(row),
      });
      if (action === "insert") {
        statements.push(masterInsert(row, at));
      } else if (action === "update_newer") {
        statements.push(masterUpdate(row, at));
      } else if (action === "conflict_hold") {
        stats.masterConflicts += 1;
      } else {
        stats.masterSkips += 1;
      }
    }
  }

  const targets = opts.category === "BASIC"
    ? [...byCode.keys()]
    : [...statusCodes];
  for (const code of targets) {
    const row = byCode.get(code) ?? null;
    const school = opts.schools.find((s) => s.code === code);
    const students = school?.students ?? null;
    const payload = opts.outcome.kind === "failed" && !row
      ? { status: "FAILED" as CategoryStatus, parsed: { applicability: "FAILED" } }
      : categoryPayload(opts.category, opts.level, row, students, opts.datasetAbsent);
    statements.push(snapshotStmt(code, opts.category, opts.year, payload.status, payload.parsed, row, at));
    const prev = prior.get(code);
    if (shouldWriteStatus(prev, payload.status, opts.year)) {
      statements.push(statusStmt(code, opts.category, payload.status, opts.year, payload.status, at));
      stats.statusWrites += 1;
    }
  }
  statements.push(
    checkpointStmt(
      opts.scope,
      opts.outcome.kind === "ok" ? "complete" : opts.outcome.kind,
      opts.year,
      opts.category,
      opts.outcome,
    ),
  );
  await runBatch(opts.db, statements);
}

async function openApiUrl(p: {
  apiType: string;
  kind: string;
  sido: string;
  sgg: string;
  year: string;
  depthNo?: string;
}): Promise<string> {
  const key = process.env.SCHOOLINFO_API_KEY?.trim();
  if (!key) throw new Error("SCHOOLINFO_API_KEY missing");
  const url = new URL(OPEN_API);
  url.searchParams.set("apiKey", key);
  url.searchParams.set("apiType", p.apiType);
  url.searchParams.set("schulKndCode", p.kind);
  url.searchParams.set("sidoCode", p.sido);
  url.searchParams.set("sggCode", p.sgg);
  url.searchParams.set("pbanYr", p.year);
  if (p.depthNo) url.searchParams.set("depthNo", p.depthNo);
  return url.toString();
}

async function loadCategory(opts: {
  db: Client;
  lawd: Lawd;
  level: SchoolLevel;
  kind: string;
  category: Exclude<Category, "GRADUATE_PATH">;
  schools: ScopeSchool[];
}): Promise<void> {
  const { category } = opts;
  const api = API_CATEGORY[category];
  const sidoCode = opts.lawd.code.slice(0, 2);
  const [sido, ...rest] = opts.lawd.fullName.split(/\s+/);
  const region = {
    sido: sido ?? "",
    sigungu: rest.join(" "),
    sidoCode,
    sggCode: opts.lawd.code,
  };

  const primaryScope = scopeKey(PREFERRED_YEAR, opts.lawd.code, opts.kind, category);
  const primaryState = await checkpointStatus(opts.db, primaryScope);
  if (primaryState === "complete") {
    stats.reused += 1;
    return;
  }

  let year = PREFERRED_YEAR;
  let outcome: FetchOutcome;
  if (primaryState === "empty") {
    stats.reused += 1;
    const fallbackScope = scopeKey(FALLBACK_YEAR, opts.lawd.code, opts.kind, category);
    const fallbackState = await checkpointStatus(opts.db, fallbackScope);
    if (fallbackState === "complete" || fallbackState === "empty") {
      stats.reused += 1;
      return;
    }
    year = FALLBACK_YEAR;
    outcome = await fetchJson(await openApiUrl({
      apiType: api.apiType,
      kind: opts.kind,
      sido: sidoCode,
      sgg: opts.lawd.code,
      year,
      depthNo: api.depthNo,
    }));
  } else {
    outcome = await fetchJson(await openApiUrl({
      apiType: api.apiType,
      kind: opts.kind,
      sido: sidoCode,
      sgg: opts.lawd.code,
      year,
      depthNo: api.depthNo,
    }));
    if (outcome.kind === "empty") {
      await runBatch(opts.db, [checkpointStmt(primaryScope, "empty", year, category, outcome)]);
      year = FALLBACK_YEAR;
      const fallbackScope = scopeKey(year, opts.lawd.code, opts.kind, category);
      const fallbackState = await checkpointStatus(opts.db, fallbackScope);
      if (fallbackState === "complete" || fallbackState === "empty") {
        stats.reused += 1;
        return;
      }
      outcome = await fetchJson(await openApiUrl({
        apiType: api.apiType,
        kind: opts.kind,
        sido: sidoCode,
        sgg: opts.lawd.code,
        year,
        depthNo: api.depthNo,
      }));
    }
  }

  const schools = category === "BASIC" ? [] : opts.schools;
  const absent = outcome.kind === "empty";
  await persistCategory({
    db: opts.db,
    category,
    level: opts.level,
    year: outcome.kind === "failed" ? PREFERRED_YEAR : year,
    rows: outcome.rows,
    schools,
    region,
    datasetAbsent: absent && category === "SCHOLARSHIP" && opts.level === "elementary",
    outcome,
    scope: scopeKey(outcome.kind === "failed" ? PREFERRED_YEAR : year, opts.lawd.code, opts.kind, category),
  });
}

async function backfillOpenApi(db: Client, lawds: Lawd[], kinds: typeof KINDS): Promise<void> {
  let n = 0;
  for (const lawd of lawds) {
    for (const kind of kinds) {
      n += 1;
      await loadCategory({
        db,
        lawd,
        level: kind.level,
        kind: kind.code,
        category: "BASIC",
        schools: [],
      });
      let schools = await loadScopeSchools(db, lawd.code, kind.level);
      const parallel: Exclude<Category, "GRADUATE_PATH" | "BASIC">[] = [
        "STUDENT",
        "TEACHER",
        "MEAL",
        "AFTERSCHOOL",
      ];
      await Promise.all(parallel.map((category) => loadCategory({
        db,
        lawd,
        level: kind.level,
        kind: kind.code,
        category,
        schools,
      })));
      schools = await loadScopeSchools(db, lawd.code, kind.level);
      await loadCategory({
        db,
        lawd,
        level: kind.level,
        kind: kind.code,
        category: "SCHOLARSHIP",
        schools,
      });
      if (n % 10 === 0) {
        console.log(`progress scopes=${n} calls=${stats.calls} reused=${stats.reused} failures=${stats.failures} masters=${stats.masterInserts}`);
      }
    }
  }
}

async function markGraduateGaps(db: Client): Promise<void> {
  const res = await db.execute({
    sql: `SELECT m.school_code, m.school_level
          FROM school_master m
          WHERE m.school_level IN ('middle', 'high')
            AND NOT EXISTS (
              SELECT 1 FROM school_data_status s
              WHERE s.school_code = m.school_code AND s.category = 'GRADUATE_PATH'
            )`,
    args: [],
  });
  if (res.rows.length === 0) return;
  const at = nowIso();
  const statements: InStatement[] = res.rows.flatMap((row) => {
    const code = String(row.school_code);
    const level = String(row.school_level);
    return [
      snapshotStmt(code, "GRADUATE_PATH", GRADUATE_YEAR, "NO_DATA", { applicability: "NO_DATA", level }, null, at),
      statusStmt(code, "GRADUATE_PATH", "NO_DATA", GRADUATE_YEAR, "absent_from_2025_feed", at),
    ];
  });
  stats.statusWrites += res.rows.length;
  await runBatch(db, statements);
}

async function backfillGraduate(db: Client): Promise<void> {
  for (const kind of ["03", "04"] as const) {
    const level: SchoolLevel = kind === "03" ? "middle" : "high";
    const key = scopeKey(GRADUATE_YEAR, "*", kind, "GRADUATE_PATH");
    const state = await checkpointStatus(db, key);
    if (state === "complete" || state === "empty") {
      stats.reused += 1;
      continue;
    }
    const url = new URL(OPEN_DATA);
    url.searchParams.set("openDataType", "json");
    url.searchParams.set("apiType", "52");
    url.searchParams.set("pbanYr", GRADUATE_YEAR);
    url.searchParams.set("schulKndCode", kind);
    url.searchParams.set("sidoCode", "11");
    const outcome = await fetchJson(url.toString());
    if (outcome.kind !== "ok") {
      await runBatch(db, [checkpointStmt(key, outcome.kind, GRADUATE_YEAR, "GRADUATE_PATH", outcome)]);
      continue;
    }
    const sidos = new Set(outcome.rows.map((row) => String(row.ADRCD_NM ?? "").split(/\s+/)[0]).filter(Boolean));
    if (sidos.size < 10) {
      throw new Error(`graduate feed for kind ${kind} was not national (sidos=${sidos.size})`);
    }
    const byCode = indexRows(outcome.rows);
    const codes = [...byCode.keys()];
    const levelByCode = new Map<string, SchoolLevel>();
    for (let i = 0; i < codes.length; i += 80) {
      const slice = codes.slice(i, i + 80);
      const res = await db.execute({
        sql: `SELECT school_code, school_level FROM school_master WHERE school_code IN (${slice.map(() => "?").join(",")})`,
        args: slice,
      });
      for (const row of res.rows) levelByCode.set(String(row.school_code), String(row.school_level) as SchoolLevel);
    }
    const prior = await existingStatuses(db, codes, "GRADUATE_PATH");
    const at = nowIso();
    const statements: InStatement[] = [];
    for (const [code, row] of byCode) {
      const rowLevel = levelFromKindCode(String(row.SCHUL_KND_SC_CODE ?? "")) ?? levelByCode.get(code) ?? level;
      if (rowLevel === "elementary") continue;
      const parsed = rowLevel === "high" ? parseHighGraduate(row) : parseMiddleGraduate(row);
      const status = graduateCategoryStatus(rowLevel, parsed);
      statements.push(snapshotStmt(code, "GRADUATE_PATH", GRADUATE_YEAR, status, parsed, row, at));
      if (shouldWriteStatus(prior.get(code), status, GRADUATE_YEAR)) {
        statements.push(statusStmt(code, "GRADUATE_PATH", status, GRADUATE_YEAR, status, at));
        stats.statusWrites += 1;
      }
    }
    statements.push(checkpointStmt(key, "complete", GRADUATE_YEAR, "GRADUATE_PATH", outcome));
    await runBatch(db, statements);
    console.log(`graduate ${level} rows=${outcome.rows.length} sidos=${sidos.size}`);
  }
  await markGraduateGaps(db);
}

async function markElementaryGraduate(db: Client): Promise<void> {
  const at = nowIso();
  const res = await db.execute({
    sql: `SELECT school_code FROM school_master WHERE school_level = 'elementary'`,
    args: [],
  });
  const codes = res.rows.map((row) => String(row.school_code));
  const prior = await existingStatuses(db, codes, "GRADUATE_PATH");
  const statements: InStatement[] = [];
  for (const code of codes) {
    statements.push(snapshotStmt(
      code,
      "GRADUATE_PATH",
      GRADUATE_YEAR,
      "NOT_APPLICABLE",
      { applicability: "NOT_APPLICABLE", reason: "elementary" },
      null,
      at,
    ));
    if (shouldWriteStatus(prior.get(code), "NOT_APPLICABLE", GRADUATE_YEAR)) {
      statements.push(statusStmt(code, "GRADUATE_PATH", "NOT_APPLICABLE", GRADUATE_YEAR, "elementary", at));
      stats.statusWrites += 1;
    }
  }
  await runBatch(db, statements);
}

async function materializeNearby(db: Client): Promise<void> {
  const schools = await db.execute({
    sql: `SELECT school_code, school_level, lat, lng, source_as_of
          FROM school_master
          WHERE status = 'operating' AND lat IS NOT NULL AND lng IS NOT NULL`,
    args: [],
  });
  const complexes = await db.execute({
    sql: `SELECT complex_id, latitude, longitude
          FROM apt_complex_master
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    args: [],
  });
  type SchoolPoint = { code: string; level: string; lat: number; lng: number; sourceAsOf: string };
  const points: SchoolPoint[] = schools.rows.map((row) => ({
    code: String(row.school_code),
    level: String(row.school_level),
    lat: Number(row.lat),
    lng: Number(row.lng),
    sourceAsOf: String(row.source_as_of),
  }));
  const cell = 0.02;
  const grid = new Map<string, SchoolPoint[]>();
  for (const school of points) {
    const key = `${Math.floor(school.lat / cell)}:${Math.floor(school.lng / cell)}`;
    const list = grid.get(key);
    if (list) list.push(school);
    else grid.set(key, [school]);
  }
  const existing = await db.execute({
    sql: "SELECT complex_id, school_code FROM complex_nearby_schools",
    args: [],
  });
  const seen = new Set(existing.rows.map((row) => `${row.complex_id}|${row.school_code}`));
  const statements: InStatement[] = [];
  for (const complex of complexes.rows) {
    const complexId = String(complex.complex_id);
    const lat = Number(complex.latitude);
    const lng = Number(complex.longitude);
    const gx = Math.floor(lat / cell);
    const gy = Math.floor(lng / cell);
    const hits: Array<SchoolPoint & { distanceM: number }> = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const bucket = grid.get(`${gx + dx}:${gy + dy}`);
        if (!bucket) continue;
        for (const school of bucket) {
          const distanceM = Math.round(haversineMeters(lat, lng, school.lat, school.lng));
          if (distanceM <= NEARBY_RADIUS_M) hits.push({ ...school, distanceM });
        }
      }
    }
    const byLevel = new Map<string, Array<SchoolPoint & { distanceM: number }>>();
    for (const hit of hits) {
      const list = byLevel.get(hit.level) ?? [];
      list.push(hit);
      byLevel.set(hit.level, list);
    }
    for (const list of byLevel.values()) {
      list.sort((a, b) => a.distanceM - b.distanceM || (a.code < b.code ? -1 : 1));
      list.forEach((hit, index) => {
        const id = `${complexId}|${hit.code}`;
        if (seen.has(id)) {
          stats.nearbySkips += 1;
          return;
        }
        seen.add(id);
        statements.push({
          sql: `INSERT INTO complex_nearby_schools (
            complex_id, school_code, distance_m, school_level, rank_by_distance,
            source_as_of, distance_basis, classification
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, school_code) DO NOTHING`,
          args: [
            complexId,
            hit.code,
            hit.distanceM,
            hit.level,
            index + 1,
            hit.sourceAsOf,
            DISTANCE_BASIS,
            NEARBY_CLASSIFICATION,
          ],
        });
      });
    }
  }
  await runBatch(db, statements);
}

function countMap(rows: Array<Record<string, unknown>>, keyA: string, keyB: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const a = String(row[keyA]);
    const b = String(row[keyB]);
    out[a] ??= {};
    out[a][b] = Number(row.n ?? 0);
  }
  return out;
}

async function buildReport(db: Client): Promise<Record<string, unknown>> {
  const master = await db.execute(`
    SELECT school_level AS level, status, COUNT(*) AS n,
      SUM(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS coords
    FROM school_master GROUP BY school_level, status`);
  const cats = await db.execute(`
    SELECT category, status, COUNT(*) AS n FROM school_data_status GROUP BY category, status`);
  const regions = await db.execute(`
    SELECT
      CASE
        WHEN sido LIKE '서울%' THEN 'seoul'
        WHEN sido LIKE '경기%' THEN 'gyeonggi'
        ELSE 'other'
      END AS region,
      school_code
    FROM school_master`);
  const statusRows = await db.execute(`
    SELECT school_code, category, status FROM school_data_status`);
  const bySchool = new Map<string, string[]>();
  for (const row of statusRows.rows) {
    const list = bySchool.get(String(row.school_code)) ?? [];
    list.push(String(row.status));
    bySchool.set(String(row.school_code), list);
  }
  const regionOf = new Map(regions.rows.map((row) => [String(row.school_code), String(row.region)]));
  const rollup = { seoul: { schools: 0, complete: 0, partial: 0, no_data: 0, failed: 0 }, gyeonggi: { schools: 0, complete: 0, partial: 0, no_data: 0, failed: 0 }, other: { schools: 0, complete: 0, partial: 0, no_data: 0, failed: 0 } };
  for (const [code, region] of regionOf) {
    const bucket = rollup[region as keyof typeof rollup];
    bucket.schools += 1;
    const status = rollupSchool(bySchool.get(code) ?? []);
    if (status === "COMPLETE") bucket.complete += 1;
    else if (status === "PARTIAL") bucket.partial += 1;
    else if (status === "FAILED") bucket.failed += 1;
    else bucket.no_data += 1;
  }
  const complexCounts = await db.execute(`
    SELECT
      CASE WHEN sido LIKE '서울%' THEN 'seoul' WHEN sido LIKE '경기%' THEN 'gyeonggi' ELSE 'other' END AS region,
      COUNT(*) AS complexes,
      SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS with_coord
    FROM apt_complex_master GROUP BY region`);
  const nearby = await db.execute(`
    SELECT c.sido, n.school_level, n.complex_id
    FROM complex_nearby_schools n
    JOIN apt_complex_master c ON c.complex_id = n.complex_id`);
  const nearbySets = new Map<string, Set<string>>();
  for (const row of nearby.rows) {
    const sido = String(row.sido);
    const region = sido.startsWith("서울") ? "seoul" : sido.startsWith("경기") ? "gyeonggi" : "national";
    for (const key of [region, "national"]) {
      const id = `${key}|${row.complex_id}`;
      const set = nearbySets.get(id) ?? new Set<string>();
      set.add(String(row.school_level));
      nearbySets.set(id, set);
    }
  }
  function nearbyCoverage(region: "seoul" | "gyeonggi" | "national") {
    let elementary = 0;
    let middle = 0;
    let high = 0;
    let all = 0;
    const ids = new Set<string>();
    for (const [id, levels] of nearbySets) {
      if (!id.startsWith(`${region}|`)) continue;
      ids.add(id);
      if (levels.has("elementary")) elementary += 1;
      if (levels.has("middle")) middle += 1;
      if (levels.has("high")) high += 1;
      if (levels.has("elementary") && levels.has("middle") && levels.has("high")) all += 1;
    }
    return { complexes_with_link: ids.size, elementary, middle, high, all_three: all };
  }
  const pilots = await db.execute({
    sql: `SELECT s.school_code, s.category, s.disclosure_year, s.status, s.parsed_json
          FROM school_detail_snapshots s
          WHERE s.school_code IN ('S010000888', 'S010000887')
          ORDER BY s.school_code, s.category, s.disclosure_year`,
    args: [],
  });
  const orphans = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT school_code FROM school_detail_snapshots
      EXCEPT
      SELECT school_code FROM school_master
    )`);
  const duplicateSnapshots = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT school_code, category, disclosure_year, source, COUNT(*) AS c
      FROM school_detail_snapshots
      GROUP BY 1, 2, 3, 4
      HAVING c > 1
    )`);
  const checkpoint = await db.execute(`
    SELECT status, COUNT(*) AS n, SUM(attempts) AS attempts, SUM(retries) AS retries, SUM(rate_limits) AS rate_limits
    FROM school_fetch_checkpoint GROUP BY status`);
  return {
    generated_at: nowIso(),
    attribution: SCHOOLINFO_ATTRIBUTION,
    master: master.rows,
    categories: countMap(cats.rows as Array<Record<string, unknown>>, "category", "status"),
    regions: rollup,
    complexes: complexCounts.rows,
    nearby: {
      seoul: nearbyCoverage("seoul"),
      gyeonggi: nearbyCoverage("gyeonggi"),
      national: nearbyCoverage("national"),
    },
    checkpoints: checkpoint.rows,
    orphan_snapshots: Number(orphans.rows[0]?.n ?? 0),
    duplicate_snapshots: Number(duplicateSnapshots.rows[0]?.n ?? 0),
    pilots: pilots.rows.map((row) => ({
      school_code: row.school_code,
      category: row.category,
      disclosure_year: row.disclosure_year,
      status: row.status,
      parsed: JSON.parse(String(row.parsed_json ?? "null")),
    })),
    run_stats: stats,
    assignment: {
      elementary_district: "HOLD",
      middle_assignment: "HOLD",
      high_school_district: "HOLD",
      national_district_inference: "NOT_GENERATED",
    },
  };
}

function pilotOk(report: Record<string, unknown>): { jamsil: string; jamsin: string } {
  const pilots = report.pilots as Array<{ school_code: string; category: string; disclosure_year: string; status: string; parsed: { graduates?: { raw?: number }; categories?: Array<{ sourceField: string; count: number | null; label: string }> } }>;
  function check(code: string, expectedTotal2: number, anchors: Record<string, number>): string {
    const grad = pilots.find((p) => p.school_code === code && p.category === "GRADUATE_PATH" && p.disclosure_year === GRADUATE_YEAR);
    if (!grad) return "MISSING";
    if (grad.parsed?.graduates?.raw !== expectedTotal2) return `TOTAL2 ${grad.parsed?.graduates?.raw}`;
    const byField = new Map((grad.parsed.categories ?? []).map((c) => [c.sourceField, c]));
    for (const [field, count] of Object.entries(anchors)) {
      if (byField.get(field)?.count !== count) return `${field} ${byField.get(field)?.count}`;
    }
    const required = ["BASIC", "STUDENT", "TEACHER", "MEAL", "AFTERSCHOOL", "SCHOLARSHIP", "GRADUATE_PATH"];
    const present = new Set(pilots.filter((p) => p.school_code === code).map((p) => p.category));
    for (const category of required) {
      if (!present.has(category)) return `missing ${category}`;
    }
    return "PASS";
  }
  return {
    jamsil: check("S010000888", 337, { TOTAL3: 223, TOTAL4: 6, TOTAL6: 9, TOTAL9: 86, TOTAL11: 5 }),
    jamsin: check("S010000887", 327, { TOTAL3: 236, TOTAL4: 8, TOTAL6: 6, TOTAL9: 61, TOTAL11: 7 }),
  };
}

async function main(): Promise<void> {
  const write = hasFlag("write");
  const reportOnly = hasFlag("report-only");
  const nearbyOnly = hasFlag("nearby-only");
  const skipNearby = hasFlag("skip-nearby");
  const skipGraduate = hasFlag("skip-graduate");
  if (!write && !reportOnly) {
    console.log(JSON.stringify({ write: false, note: "pass --write to load production school tables" }));
    return;
  }
  const db = dbClient();
  if (!reportOnly) await applySchema(db);
  if (!reportOnly && !nearbyOnly) {
    const sido = arg("sido");
    const sgg = arg("sgg");
    const kindArg = arg("kind");
    let lawds = (lawdRows as Lawd[]).slice().sort((a, b) => {
      const pa = PRIORITY.indexOf(a.code.slice(0, 2));
      const pb = PRIORITY.indexOf(b.code.slice(0, 2));
      const da = pa < 0 ? 99 : pa;
      const dbv = pb < 0 ? 99 : pb;
      if (da !== dbv) return da - dbv;
      return a.code < b.code ? -1 : 1;
    });
    if (sido) lawds = lawds.filter((row) => row.code.startsWith(sido));
    if (sgg) lawds = lawds.filter((row) => row.code === sgg);
    const max = Number(arg("max-scopes") ?? "0");
    const kinds = kindArg ? KINDS.filter((k) => k.code === kindArg) : KINDS;
    const scopes = kinds.length * lawds.length;
    const limited = max > 0 ? lawds.slice(0, Math.ceil(max / kinds.length)) : lawds;
    console.log(`openApi scopes=${scopes} running=${limited.length * kinds.length}`);
    await backfillOpenApi(db, limited, kinds);
    if (!skipGraduate && !sido && !sgg) {
      await backfillGraduate(db);
      await markElementaryGraduate(db);
    }
  }
  if (!reportOnly && !skipNearby && !arg("sgg")) await materializeNearby(db);
  const report = await buildReport(db);
  const parity = pilotOk(report);
  const outDir = path.join(process.cwd(), "data/poc/school-national");
  mkdirSync(outDir, { recursive: true });
  const payload = { ...report, pilot_parity: parity };
  writeFileSync(path.join(outDir, "coverage-report.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ pilot_parity: parity, run_stats: stats, regions: report.regions }, null, 2));
  if (parity.jamsil !== "PASS" || parity.jamsin !== "PASS") process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
