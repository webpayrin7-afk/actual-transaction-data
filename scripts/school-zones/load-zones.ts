/**
 * build-zones.py 결과 → elem_school_zones · elem_school_zone_schools · complex_elem_school_zones. 이 세 테이블 외 쓰기 없음.
 *
 *   npx tsx scripts/school-zones/load-zones.ts --in=C:/data/school/work/zones-11-41.json            # dry-run
 *   npx tsx scripts/school-zones/load-zones.ts --in=C:/data/school/work/zones-11-41.json --apply
 *
 * missing-only(INSERT OR IGNORE, 배치 200). 다시 돌리면 0. 있는 행은 고치지 않는다.
 * 학교 코드: school_master 초등학교 중 학교명 + 시도코드가 정확히 같은 것. 여럿이면 같은 시군구 → 운영 중 하나로만 가린다.
 * 그래도 하나로 안 정해지거나 없으면 NULL (이름 비슷한 학교로 잇지 않는다).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";

const ZONE_SOURCE = "한국지방교육행정연구재단·한국교육시설안전원 초등학교통학구역";
const LINK_SOURCE = "전국학교학구도연계정보표준데이터";
const PROBES = ["잠실엘스", "래미안원베일리", "헬리오시티"];

type Zone = {
  zone_id: string;
  zone_name: string;
  zone_kind: "single" | "joint";
  hakgudo_gb: string;
  sd_cd: string;
  sgg_cd: string | null;
  edu_office: string | null;
  bbox: number[];
  geojson: string;
  bytes: number;
  simplify_m: number;
  upd_dt: string | null;
  base_date: string;
};
type School = { zone_id: string; facility_school_id: string; school_name: string };
type Link = { complex_id: string; zone_id: string; zone_kind: string; lat: number; lng: number; src: string };
type Built = { stats: Record<string, unknown> & { link_base_date: string | null; sds: string[] }; zones: Zone[]; schools: School[]; links: Link[] };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const inFile = arg("in");
  const apply = process.argv.includes("--apply");
  if (!inFile) throw new Error("--in=path 필요");
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음 (.env.local)");
  const built = JSON.parse(readFileSync(inFile, "utf8")) as Built;
  const sds = built.stats.sds;
  const linkBase = built.stats.link_base_date;
  if (!linkBase) throw new Error("연계정보 기준일 없음");
  const zoneById = new Map(built.zones.map((z) => [z.zone_id, z]));
  const zoneBase = [...new Set(built.zones.map((z) => z.base_date))];
  if (zoneBase.length !== 1) throw new Error(`통학구역 기준일이 여럿: ${zoneBase.join(",")}`);

  // 학교 코드 — 정확 일치만
  const sm = await db.execute({
    sql: `SELECT school_code, school_name, sido_code, sgg_code, status FROM school_master
           WHERE school_level = 'elementary' AND sido_code IN (${sds.map(() => "?").join(",")})`,
    args: sds,
  });
  const byKey = new Map<string, Array<{ code: string; sgg: string | null; status: string | null }>>();
  for (const r of sm.rows) {
    const k = `${String(r.sido_code)}|${String(r.school_name).trim()}`;
    const list = byKey.get(k) ?? [];
    list.push({ code: String(r.school_code), sgg: r.sgg_code == null ? null : String(r.sgg_code), status: r.status == null ? null : String(r.status) });
    byKey.set(k, list);
  }
  let matched = 0;
  let ambiguous = 0;
  const unmatchedNames: string[] = [];
  const schoolCode = (s: School): string | null => {
    const z = zoneById.get(s.zone_id)!;
    let c = byKey.get(`${z.sd_cd}|${s.school_name}`) ?? [];
    if (c.length > 1 && z.sgg_cd) {
      const same = c.filter((x) => x.sgg === `${z.sd_cd}${z.sgg_cd}`);
      if (same.length) c = same;
    }
    if (c.length > 1) {
      const op = c.filter((x) => x.status === "operating");
      if (op.length) c = op;
    }
    if (c.length === 1) {
      matched++;
      return c[0]!.code;
    }
    if (c.length > 1) ambiguous++;
    else unmatchedNames.push(s.school_name);
    return null;
  };
  const schoolRows = built.schools.map((s) => ({ ...s, school_code: schoolCode(s) }));

  const exists = async (t: string) =>
    (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [t] })).rows.length > 0;
  const haveZones = new Set<string>();
  const haveSchools = new Set<string>();
  const haveLinks = new Set<string>();
  if (await exists("elem_school_zones"))
    for (const r of (await db.execute("SELECT zone_id FROM elem_school_zones")).rows) haveZones.add(String(r.zone_id));
  if (await exists("elem_school_zone_schools"))
    for (const r of (await db.execute("SELECT zone_id, facility_school_id FROM elem_school_zone_schools")).rows)
      haveSchools.add(`${r.zone_id}|${r.facility_school_id}`);
  if (await exists("complex_elem_school_zones"))
    for (const r of (await db.execute("SELECT complex_id, zone_id FROM complex_elem_school_zones")).rows)
      haveLinks.add(`${r.complex_id}|${r.zone_id}`);

  const newZones = built.zones.filter((z) => !haveZones.has(z.zone_id));
  const newSchools = schoolRows.filter((s) => !haveSchools.has(`${s.zone_id}|${s.facility_school_id}`));
  const newLinks = built.links.filter((l) => !haveLinks.has(`${l.complex_id}|${l.zone_id}`));

  // 확인용 단지 몇 곳
  const probeRows = (
    await db.execute({
      sql: `SELECT complex_id, apt_name FROM apt_complex_master WHERE apt_name IN (${PROBES.map(() => "?").join(",")})`,
      args: PROBES,
    })
  ).rows;
  const probes = probeRows.map((r) => {
    const id = String(r.complex_id);
    const zs = built.links.filter((l) => l.complex_id === id);
    return {
      complex_id: id,
      apt_name: String(r.apt_name),
      zones: zs.map((l) => ({
        zone: zoneById.get(l.zone_id)?.zone_name,
        kind: l.zone_kind,
        bytes: zoneById.get(l.zone_id)?.bytes,
        schools: schoolRows.filter((s) => s.zone_id === l.zone_id).map((s) => `${s.school_name}${s.school_code ? ` (${s.school_code})` : " (코드 없음)"}`),
      })),
    };
  });

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        build: built.stats,
        school_code_match: { links: schoolRows.length, matched, ambiguous, unmatched: unmatchedNames.length, unmatched_examples: unmatchedNames.slice(0, 15) },
        elem_school_zones: { source: built.zones.length, existing: haveZones.size, insert: newZones.length },
        elem_school_zone_schools: { source: schoolRows.length, existing: haveSchools.size, insert: newSchools.length },
        complex_elem_school_zones: { source: built.links.length, existing: haveLinks.size, insert: newLinks.length },
        probes,
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20261003_elem_school_zones.sql"), "utf8");
  for (const stmt of ddl.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  const now = new Date().toISOString();
  const run = async (stmts: InStatement[]) => {
    let affected = 0;
    for (let i = 0; i < stmts.length; i += 200) {
      const res = await db.batch(stmts.slice(i, i + 200), "write");
      affected += res.reduce((a, x) => a + x.rowsAffected, 0);
    }
    return affected;
  };
  const applied = {
    elem_school_zones: await run(
      newZones.map((z) => ({
        sql: `INSERT OR IGNORE INTO elem_school_zones (zone_id, zone_name, zone_kind, hakgudo_gb, sd_cd, sgg_cd, edu_office, bbox, geojson, bytes, simplify_m, upd_dt, base_date, source, loaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [z.zone_id, z.zone_name, z.zone_kind, z.hakgudo_gb, z.sd_cd, z.sgg_cd, z.edu_office, JSON.stringify(z.bbox), z.geojson, z.bytes, z.simplify_m, z.upd_dt, z.base_date, ZONE_SOURCE, now],
      })),
    ),
    elem_school_zone_schools: await run(
      newSchools.map((s) => ({
        sql: `INSERT OR IGNORE INTO elem_school_zone_schools (zone_id, facility_school_id, school_name, school_code, base_date, source, loaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [s.zone_id, s.facility_school_id, s.school_name, s.school_code, linkBase, LINK_SOURCE, now],
      })),
    ),
    complex_elem_school_zones: await run(
      newLinks.map((l) => ({
        sql: `INSERT OR IGNORE INTO complex_elem_school_zones (complex_id, zone_id, zone_kind, point_lat, point_lng, point_source, zone_base_date, computed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [l.complex_id, l.zone_id, l.zone_kind, l.lat, l.lng, l.src, zoneBase[0]!, now],
      })),
    ),
  };
  console.log(JSON.stringify({ applied }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
