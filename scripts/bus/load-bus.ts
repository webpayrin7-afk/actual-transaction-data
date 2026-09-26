/**
 * 전국 버스정류장 위치(CSV) → bus_stops, 서울 노선별 정류소(JSON) → bus_stop_routes. 이 두 테이블 외 쓰기 없음.
 *
 *   python scripts/bus/routes-to-json.py "C:/data/bus/서울시버스노선별정류소정보(20260902).xlsx" C:/data/bus/routes.json
 *   npx tsx scripts/bus/load-bus.ts --stops="C:/data/bus/국토교통부_전국 버스정류장 위치정보_20251031.csv" --routes=C:/data/bus/routes.json            # dry-run
 *   npx tsx scripts/bus/load-bus.ts --stops=... --routes=... --apply
 *
 * missing-only(INSERT OR IGNORE, 배치 500). 다시 돌리면 0. 값은 원문 그대로.
 * 정류장: 좌표가 비었거나 숫자가 아니거나 한국 범위 밖이면 건너뜀, 같은 정류장번호는 첫 행만.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";

const STOP_SOURCE = "국토교통부 전국 버스정류장 위치정보 (2025-10-31)";
const ROUTE_SOURCE = "서울시 버스노선별 정류소정보 (2026-09-02)";
const ROUTE_BASE_DATE = "2026-09-02";
const PROBE = { name: "잠실새내역", lat: 37.5117, lng: 127.086, radiusM: 300 };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** RFC 4180 한 줄(따옴표 안 쉼표 허용; 이 원천엔 줄바꿈 든 칸이 없다). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const str = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v.trim());

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const stopsFile = arg("stops");
  const routesFile = arg("routes");
  if (!stopsFile || !routesFile) throw new Error("--stops=<csv> --routes=<json> 이 필요합니다.");
  const apply = process.argv.includes("--apply");

  // 정류장
  const text = new TextDecoder("euc-kr").decode(readFileSync(stopsFile));
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = splitCsv(lines[0]!).map((h) => h.trim());
  const need = ["정류장번호", "정류장명", "위도", "경도", "정보수집일", "모바일단축번호", "도시코드", "도시명", "관리도시명"];
  const idx = Object.fromEntries(need.map((h) => [h, header.indexOf(h)]));
  if (Object.values(idx).some((i) => i < 0)) throw new Error(`머리글이 다릅니다: ${header.join(",")}`);

  const skipped: Record<string, number> = { coord_empty: 0, coord_not_number: 0, coord_out_of_korea: 0, no_stop_id_or_name: 0, duplicate_stop_id: 0 };
  const stops = new Map<string, (string | number | null)[]>();
  for (const line of lines.slice(1)) {
    const c = splitCsv(line);
    const get = (h: string) => str(c[idx[h]!]);
    const id = get("정류장번호");
    const name = get("정류장명");
    const latS = get("위도");
    const lngS = get("경도");
    if (!id || !name) { skipped.no_stop_id_or_name!++; continue; }
    if (!latS || !lngS) { skipped.coord_empty!++; continue; }
    const lat = Number(latS);
    const lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped.coord_not_number!++; continue; }
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) { skipped.coord_out_of_korea!++; continue; }
    if (stops.has(id)) { skipped.duplicate_stop_id!++; continue; }
    stops.set(id, [id, name, lat, lng, get("정보수집일"), get("모바일단축번호"), get("도시코드"), get("도시명"), get("관리도시명")]);
  }

  // 노선
  const rawRoutes = JSON.parse(readFileSync(routesFile, "utf8")) as Record<string, string | null>[];
  const routes = new Map<string, (string | number | null)[]>();
  let routeBad = 0;
  let routeDup = 0;
  for (const r of rawRoutes) {
    const routeId = str(r["ROUTE_ID"]);
    const seq = Number(str(r["순번"]));
    const routeNo = str(r["노선명"]);
    if (!routeId || !routeNo || !Number.isInteger(seq)) { routeBad++; continue; }
    const key = `${routeId}|${seq}`;
    if (routes.has(key)) { routeDup++; continue; }
    routes.set(key, [routeId, seq, routeNo, str(r["NODE_ID"]), str(r["ARS_ID"]), str(r["정류소명"])]);
  }

  // 보고용
  const cityCount = new Map<string, number>();
  for (const s of stops.values()) {
    const k = `${s[6]} ${s[7]}`;
    cityCount.set(k, (cityCount.get(k) ?? 0) + 1);
  }
  const arsSet = new Set([...stops.values()].map((s) => s[5]).filter(Boolean) as string[]);
  const routeRows = [...routes.values()];
  const joined = routeRows.filter((r) => r[4] && arsSet.has(String(r[4]))).length;
  const near = [...stops.values()]
    .map((s) => ({ stop_id: s[0], name: s[1], ars_no: s[5], m: Math.round(haversineM(PROBE.lat, PROBE.lng, Number(s[2]), Number(s[3]))) }))
    .filter((s) => s.m <= PROBE.radiusM)
    .sort((a, b) => a.m - b.m);

  const exists = async (t: string) =>
    (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [t] })).rows.length > 0;
  const haveStops = new Set<string>();
  const haveRoutes = new Set<string>();
  if (await exists("bus_stops")) for (const r of (await db.execute("SELECT stop_id FROM bus_stops")).rows) haveStops.add(String(r.stop_id));
  if (await exists("bus_stop_routes"))
    for (const r of (await db.execute("SELECT route_id, seq FROM bus_stop_routes")).rows) haveRoutes.add(`${r.route_id}|${r.seq}`);
  const newStops = [...stops.values()].filter((s) => !haveStops.has(String(s[0])));
  const newRoutes = [...routes.entries()].filter(([k]) => !haveRoutes.has(k)).map(([, v]) => v);

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        bus_stops: { source_rows: lines.length - 1, valid: stops.size, skipped, existing: haveStops.size, insert: newStops.length },
        city_top10: [...cityCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
        seoul: cityCount.get("11 서울특별시") ?? 0,
        bus_stop_routes: {
          source_rows: rawRoutes.length, valid: routes.size, skipped_bad: routeBad, skipped_dup: routeDup,
          routes: new Set(routeRows.map((r) => r[0])).size, existing: haveRoutes.size, insert: newRoutes.length,
          ars_exact_join_rows: joined,
        },
        near_probe: { ...PROBE, count: near.length, examples: near.slice(0, 5) },
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260930_bus_stops.sql"), "utf8");
  for (const stmt of ddl.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  const now = new Date().toISOString();
  const run = async (stmts: InStatement[]) => {
    let affected = 0;
    for (let i = 0; i < stmts.length; i += 500) {
      const res = await db.batch(stmts.slice(i, i + 500), "write");
      affected += res.reduce((a, x) => a + x.rowsAffected, 0);
    }
    return affected;
  };
  const applied = {
    bus_stops: await run(
      newStops.map((s) => ({
        sql: `INSERT OR IGNORE INTO bus_stops (stop_id, name, lat, lng, collected_date, ars_no, city_code, city_name, manager_city, source, loaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [...s, STOP_SOURCE, now],
      })),
    ),
    bus_stop_routes: await run(
      newRoutes.map((r) => ({
        sql: `INSERT OR IGNORE INTO bus_stop_routes (route_id, seq, route_no, node_id, ars_id, stop_name, base_date, source, loaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [...r, ROUTE_BASE_DATE, ROUTE_SOURCE, now],
      })),
    ),
  };
  console.log(JSON.stringify({ applied }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
