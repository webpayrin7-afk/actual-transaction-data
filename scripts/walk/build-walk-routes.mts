/**
 * 3D 걷기 경로 미리 만들기 — 단지마다 OSM 보행망 추출본(complex_walk_osm)과 기본 결과(complex_walk_routes, 걷기·유모차 2행)를 저장한다.
 * 요청 때 Overpass를 기다리지 않게 하려는 것. 테이블은 migrations/20261001_complex_walk.sql (없으면 만든다, 새 테이블만).
 *
 * 단지 지정:
 *   npx tsx scripts/walk/build-walk-routes.mts cx_4c63d9a100973c60 cx_... [--refresh-osm] [--dry-run]
 *
 * 한꺼번에 (3D 모형이 있는 단지 = 모양 연결된 동이 1개 이상, 세대수 많은 순):
 *   npx tsx scripts/walk/build-walk-routes.mts --batch [--phases 서울:300,경기:300,전국] [--max-minutes 180]
 *        [--progress data/walk/build-walk-progress.json] [--retry-failed] [--dry-run]
 *   - 이미 같은 규칙 버전의 결과(걷기·유모차 둘 다)가 있는 단지는 건너뛴다 → 다시 실행하면 이어서 한다
 *   - 진행 파일에 성공·실패·모형 없음을 적는다. 실패는 기본 2번까지만 다시 해 본다 (--retry-failed 면 횟수 무시)
 *   - Overpass: 한 번에 한 요청, 단지 사이 2~5초 쉼, 거울 서버(kumi → private.coffee → overpass-api.de)를 돌려 가며,
 *     429·504·시간 초과면 점점 길게 쉬었다가 다음 거울. 단지 여러 개가 잇따라 실패하면 5분 쉬고, 그래도 안 되면 멈춘다.
 *   - DB 쓰기가 한 문장에 5초를 넘으면 멈춘다.
 *
 * 쓰기: 단지당 최대 3행 (osm 1 + routes 2). 저장본이 있으면 Overpass를 부르지 않는다(--refresh-osm 이면 다시 받음).
 * --dry-run 은 계산만 하고 쓰지 않는다.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client, InStatement } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";
import { getWalkPayload, WALK_ROUTES_VERSION } from "../../src/lib/complex-3d/walk-store";
import { fetchOverpassOnce, OVERPASS_MIRROR_URLS, OverpassError, type OsmEl } from "../../src/lib/complex-3d/walk";
import { readComplex3dCoverage } from "../../src/lib/complex-3d/read";
import type { Bbox } from "../../src/lib/complex-3d/terrain";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const dry = flag("--dry-run");
const refreshOsm = flag("--refresh-osm");
const batch = flag("--batch");
const ids = args.filter((a) => /^cx_[0-9a-f]{16}$/.test(a));
if (!ids.length && !batch) {
  console.error("단지 번호(cx_…)를 하나 이상 주거나 --batch 를 주세요.");
  process.exit(1);
}

const rawDb = getDb();
if (!rawDb) {
  console.error("DB 설정 없음");
  process.exit(1);
}

// ── DB 쓰기 시간 재기 — 한 문장 5초 넘으면 멈춤 ─────────────────────────────
const SLOW_WRITE_MS = 5000;
let slowWrite: string | null = null;
let writeError: string | null = null;
const db = new Proxy(rawDb, {
  get(target, prop, recv) {
    const v = Reflect.get(target, prop, recv);
    if (prop !== "execute" || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
    return async (stmt: InStatement) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(sql);
      const t0 = Date.now();
      try {
        return await target.execute(stmt);
      } catch (e) {
        if (isWrite) writeError = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        const ms = Date.now() - t0;
        if (isWrite && ms > SLOW_WRITE_MS) slowWrite = `${ms}ms: ${sql.trim().slice(0, 60)}`;
      }
    };
  },
}) as Client;

if (!dry) {
  const sql = readFileSync(join(process.cwd(), "src/lib/db/migrations/20261001_complex_walk.sql"), "utf8");
  const stmts = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const s of stmts) await rawDb.execute(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const summary = (p: Awaited<ReturnType<typeof getWalkPayload>>) =>
  p ? p.payload.destinations.map((d) => `${d.name} ${d.totalMin}분 ${d.distanceM}m(직선 ${d.straightM}m)`).join(" | ") : "단지 없음";

// ── Overpass: 천천히, 거울을 돌려 가며 ──────────────────────────────────────
let mirrorCursor = 0;
let overpassCalls = 0;
async function politeOverpass(bbox: Bbox): Promise<{ elements: OsmEl[]; source: string }> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS_MIRROR_URLS[mirrorCursor % OVERPASS_MIRROR_URLS.length]!;
    mirrorCursor++;
    overpassCalls++;
    try {
      return await fetchOverpassOnce(bbox, url, 60_000);
    } catch (e) {
      last = e;
      const status = e instanceof OverpassError ? e.status : null;
      const timeout = e instanceof Error && /timeout|aborted/i.test(e.name + e.message);
      const wait = status === 429 ? 20_000 * (attempt + 1) : status === 504 || status === 503 || timeout ? 10_000 * (attempt + 1) : 4000;
      console.log(`   overpass ${new URL(url).host} 실패 (${e instanceof Error ? e.message : e}) — ${wait / 1000}s 쉼`);
      await sleep(wait);
    }
  }
  throw last instanceof Error ? last : new Error("overpass failed");
}

// ── 단지 지정 모드 (예전 그대로) ─────────────────────────────────────────────
if (!batch) {
  for (const [k, id] of ids.entries()) {
    if (k) await sleep(3000);
    for (const mode of ["walk", "wheel"] as const) {
      const t0 = Date.now();
      try {
        const r = await getWalkPayload(db, id, { mode, write: !dry, refreshOsm: refreshOsm && mode === "walk", fetchOsm: politeOverpass });
        console.log(id, mode, r?.source ?? "-", `${Date.now() - t0}ms`, r ? `${JSON.stringify(r.payload).length}B` : "", summary(r));
      } catch (e) {
        console.log(id, mode, "실패", e instanceof Error ? e.message : e);
      }
    }
  }
  process.exit(0);
}

// ── 한꺼번에 ────────────────────────────────────────────────────────────────
type Progress = {
  version: number;
  done: Record<string, { at: string; ms: number; source: string }>;
  failed: Record<string, { n: number; err: string; at: string }>;
  noShape: Record<string, string>;
};
const progressPath = opt("--progress", "data/walk/build-walk-progress.json");
const maxMinutes = Number(opt("--max-minutes", "180"));
const phases = opt("--phases", "서울:300,경기:300,전국")
  .split(",")
  .map((p) => {
    const [area, n] = p.split(":");
    return { area: area!.trim(), limit: n ? Number(n) : null };
  });
const retryFailed = flag("--retry-failed");

const progress: Progress = existsSync(progressPath)
  ? (JSON.parse(readFileSync(progressPath, "utf8")) as Progress)
  : { version: WALK_ROUTES_VERSION, done: {}, failed: {}, noShape: {} };
if (progress.version !== WALK_ROUTES_VERSION) {
  // 규칙이 바뀌면 성공 기록은 무의미 (DB 확인으로 다시 거른다) — 모형 없음·실패만 남긴다
  progress.version = WALK_ROUTES_VERSION;
  progress.done = {};
}
function saveProgress() {
  if (dry) return;
  mkdirSync(dirname(progressPath), { recursive: true });
  const tmp = `${progressPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(progress, null, 1));
  renameSync(tmp, progressPath);
}

const SIDO: Record<string, string> = { 서울: "서울특별시", 경기: "경기도", 인천: "인천광역시", 부산: "부산광역시" };
async function candidates(area: string, limit: number | null): Promise<Array<{ id: string; name: string; hh: number }>> {
  const where = area === "전국" ? "" : "WHERE m.sido = ?";
  const r = await rawDb!.execute({
    sql: `SELECT b.complex_id, m.apt_name, SUM(COALESCE(b.household_count, 0)) AS hh
          FROM complex_buildings b JOIN apt_complex_master m ON m.complex_id = b.complex_id
          ${where}
          GROUP BY b.complex_id ORDER BY hh DESC ${limit ? `LIMIT ${Math.floor(limit)}` : ""}`,
    args: area === "전국" ? [] : [SIDO[area] ?? area],
  });
  return r.rows.map((x) => ({ id: String(x.complex_id), name: String(x.apt_name), hh: Number(x.hh) }));
}

const built = new Set(
  (
    await rawDb.execute({
      sql: `SELECT complex_id FROM complex_walk_routes WHERE from_key = '' AND algo_version = ?
            GROUP BY complex_id HAVING COUNT(DISTINCT mode) = 2`,
      args: [WALK_ROUTES_VERSION],
    })
  ).rows.map((r) => String(r.complex_id)),
);

const queue: Array<{ id: string; name: string; hh: number; phase: string }> = [];
const seen = new Set<string>();
for (const ph of phases) {
  for (const c of await candidates(ph.area, ph.limit)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    queue.push({ ...c, phase: ph.area + (ph.limit ? `:${ph.limit}` : "") });
  }
}
const todo = queue.filter(
  (c) => !built.has(c.id) && !progress.noShape[c.id] && (retryFailed || (progress.failed[c.id]?.n ?? 0) < 2),
);
console.log(
  `후보 ${queue.length} (이미 있음 ${queue.filter((c) => built.has(c.id)).length}, 모형 없음 ${queue.filter((c) => progress.noShape[c.id]).length}) → 이번에 ${todo.length} · 최대 ${maxMinutes}분 · 규칙 v${WALK_ROUTES_VERSION}${dry ? " · 쓰지 않음" : ""}`,
);

const started = Date.now();
let ok = 0;
let fail = 0;
let noShape = 0;
let streak = 0;
let pausedOnce = false;
let stopReason = "목록 끝";
for (const [k, c] of todo.entries()) {
  if (Date.now() - started > maxMinutes * 60_000) {
    stopReason = `${maxMinutes}분 지남`;
    break;
  }
  if (slowWrite) {
    stopReason = `느린 쓰기 ${slowWrite}`;
    break;
  }
  const cov = await readComplex3dCoverage(rawDb, c.id).catch(() => null);
  if (!cov || cov.withShape === 0) {
    progress.noShape[c.id] = cov ? `동 ${cov.buildings} 모양 0` : "좌표 없음";
    noShape++;
    if (noShape % 20 === 0) saveProgress();
    continue;
  }
  const t0 = Date.now();
  const callsBefore = overpassCalls;
  writeError = null;
  try {
    const lines: string[] = [];
    let source = "";
    for (const mode of ["walk", "wheel"] as const) {
      const r = await getWalkPayload(db, c.id, { mode, write: !dry, refreshOsm: refreshOsm && mode === "walk", fetchOsm: politeOverpass });
      if (!r) throw new Error("단지 없음");
      if (!r.payload.destinations.length) throw new Error("목적지 없음 (역·학교·정류장 경로 0)");
      if (mode === "walk") {
        source = r.source;
        lines.push(summary(r));
      }
    }
    if (writeError) throw new Error(`저장 실패 ${writeError}`);
    progress.done[c.id] = { at: new Date().toISOString(), ms: Date.now() - t0, source };
    delete progress.failed[c.id];
    ok++;
    streak = 0;
    console.log(`[${k + 1}/${todo.length}] ${c.phase} ${c.id} ${c.name} ${c.hh}세대 · ${source} ${Date.now() - t0}ms · ${lines[0]}`);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const prev = progress.failed[c.id]?.n ?? 0;
    progress.failed[c.id] = { n: prev + 1, err: err.slice(0, 200), at: new Date().toISOString() };
    fail++;
    const overpassFail = e instanceof OverpassError || /overpass|timeout|aborted|fetch failed/i.test(err);
    if (overpassFail) streak++;
    console.log(`[${k + 1}/${todo.length}] ${c.phase} ${c.id} ${c.name} 실패: ${err}`);
    if (streak >= 5) {
      if (pausedOnce) {
        stopReason = "Overpass 연속 실패";
        saveProgress();
        break;
      }
      console.log("   Overpass가 잇따라 실패 — 5분 쉼");
      pausedOnce = true;
      streak = 0;
      await sleep(5 * 60_000);
    }
  }
  saveProgress();
  if (overpassCalls > callsBefore) await sleep(2000 + Math.random() * 3000);
  if (streak === 0 && ok % 50 === 0 && ok) pausedOnce = false;
}
saveProgress();

const elapsed = Math.round((Date.now() - started) / 60_000);
console.log(
  `\n끝 (${stopReason}) — ${elapsed}분 · 성공 ${ok} · 실패 ${fail} · 모형 없음 ${noShape} · Overpass 요청 ${overpassCalls}` +
    `\n누적: 성공 ${Object.keys(progress.done).length} · 실패 ${Object.keys(progress.failed).length} · 모형 없음 ${Object.keys(progress.noShape).length}` +
    `\n이어서: npx tsx scripts/walk/build-walk-routes.mts --batch --phases ${phases.map((p) => p.area + (p.limit ? `:${p.limit}` : "")).join(",")}`,
);
process.exit(0);
