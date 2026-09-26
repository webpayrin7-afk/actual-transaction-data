/**
 * 3D 걷기 경로 미리 만들기 — 단지마다 OSM 보행망 추출본(complex_walk_osm)과 기본 결과(complex_walk_routes, 걷기·유모차 2행)를 저장한다.
 * 요청 때 Overpass를 기다리지 않게 하려는 것. 테이블은 migrations/20261001_complex_walk.sql (없으면 만든다, 새 테이블만).
 *
 *   npx tsx scripts/walk/build-walk-routes.mts cx_4c63d9a100973c60 cx_... [--refresh-osm] [--dry-run]
 *
 * 쓰기: 단지당 최대 3행 (osm 1 + routes 2). 저장본이 있으면 Overpass를 부르지 않는다(--refresh-osm 이면 다시 받음).
 * Overpass는 단지 사이 3초 쉼. --dry-run 은 계산만 하고 쓰지 않는다.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";
import { getWalkPayload } from "../../src/lib/complex-3d/walk-store";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const refreshOsm = args.includes("--refresh-osm");
const ids = args.filter((a) => /^cx_[0-9a-f]{16}$/.test(a));
if (!ids.length) {
  console.error("단지 번호(cx_…)를 하나 이상 주세요.");
  process.exit(1);
}

const db = getDb();
if (!db) {
  console.error("DB 설정 없음");
  process.exit(1);
}

if (!dry) {
  const sql = readFileSync(join(process.cwd(), "src/lib/db/migrations/20261001_complex_walk.sql"), "utf8");
  const stmts = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const s of stmts) await db.execute(s);
}

for (const [k, id] of ids.entries()) {
  if (k) await new Promise((r) => setTimeout(r, 3000));
  for (const mode of ["walk", "wheel"] as const) {
    const t0 = Date.now();
    try {
      const r = await getWalkPayload(db, id, { mode, write: !dry, refreshOsm: refreshOsm && mode === "walk" });
      if (!r) {
        console.log(id, mode, "단지 없음");
        continue;
      }
      const p = r.payload;
      console.log(
        id,
        mode,
        r.source,
        `${Date.now() - t0}ms`,
        `${JSON.stringify(p).length}B`,
        p.destinations.map((d) => `${d.name} ${d.totalMin}분 ${d.distanceM}m 횡단${d.crossings}${d.steps ? " 계단" : ""}`).join(" | "),
      );
    } catch (e) {
      console.log(id, mode, "실패", e instanceof Error ? e.message : e);
    }
  }
}
