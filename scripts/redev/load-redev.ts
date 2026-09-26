/**
 * 정비구역·정비사업·연결 → redev_zones · redev_projects · redev_links. 이 세 테이블 외 쓰기 없음.
 *
 *   python scripts/redev/build-zones.py "C:/data/redev/570_UQ181_의제처리구역_202609.zip" C:/data/boundary/x/N3A_G0100000 C:/data/redev/out
 *   python scripts/redev/projects-to-json.py "C:/data/redev/★(26년 6월기준) 서울시 정비사업 추진현황.xlsx" C:/data/redev/out/projects.json
 *   npx tsx scripts/redev/fetch-inputs.ts --out=C:/data/redev/out
 *   python scripts/redev/link.py C:/data/redev/out
 *   npx tsx scripts/redev/load-redev.ts --from=C:/data/redev/out            # dry-run
 *   npx tsx scripts/redev/load-redev.ts --from=C:/data/redev/out --apply
 *
 * 구역·사업: 없는 키만 넣고, 같은 키는 원천이 바뀌었을 때만(payload_hash) 갱신. 연결: 없는 것만(INSERT OR IGNORE).
 * 다시 돌리면 insert·update 0.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InStatement } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";

const ZONE_SOURCE = "서울시 UPIS 의제처리구역 UPIS_C_UQ181 (2026-09)";
const PROJECT_SOURCE = "서울시 정비사업 추진현황 (2026년 6월 기준)";
const BASE_DATE = "2026-06-30";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

const ZONE_COLS = [
  "zone_id", "present_sn", "name", "category_code", "category_name", "lclas_cl", "mlsfc_cl", "sclas_cl", "gu", "gu_code",
  "signgu_se", "area_m2", "notice_sn", "notice_date", "wtnnc_sn", "lat", "lng", "rings",
] as const;
const PROJECT_COLS = [
  "code", "gu", "zone_name", "addr_jibun", "addr_road", "public_private", "district_type", "project_type", "stage",
  "households_before", "zone_designated_first", "zone_designated_last", "committee_approved", "association_approved",
  "building_review", "project_approved_first", "project_approved_last", "disposal_approved_first", "disposal_approved_last",
  "relocation_start", "relocation_end", "construction_start", "households_total", "households_sale", "households_rent",
] as const;

type Val = string | number | null;

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const from = arg("from");
  if (!from) throw new Error("--from=<dir> 이 필요합니다.");
  const apply = process.argv.includes("--apply");

  const zones = readFileSync(join(from, "zones.ndjson"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const z = JSON.parse(l) as Record<string, unknown>;
      const vals = ZONE_COLS.map((c) => (c === "rings" ? JSON.stringify(z.rings) : ((z[c] ?? null) as Val)));
      return { key: String(z.zone_id), vals, hash: hash(vals) };
    });
  const projects = (JSON.parse(readFileSync(join(from, "projects.json"), "utf8")) as Record<string, Val>[]).map((p) => {
    const vals = PROJECT_COLS.map((c) => p[c] ?? null);
    return { key: String(p.code), vals, hash: hash(vals) };
  });
  const links = JSON.parse(readFileSync(join(from, "links.json"), "utf8")) as Array<{
    kind: string; ref_id: string; zone_id: string; method: string; detail: string | null;
  }>;

  const exists = async (t: string) =>
    (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [t] })).rows.length > 0;
  const haveZones = new Map<string, string>();
  const haveProjects = new Map<string, string>();
  const haveLinks = new Set<string>();
  if (await exists("redev_zones"))
    for (const r of (await db.execute("SELECT zone_id, payload_hash FROM redev_zones")).rows) haveZones.set(String(r.zone_id), String(r.payload_hash));
  if (await exists("redev_projects"))
    for (const r of (await db.execute("SELECT code, payload_hash FROM redev_projects")).rows) haveProjects.set(String(r.code), String(r.payload_hash));
  if (await exists("redev_links"))
    for (const r of (await db.execute("SELECT kind, ref_id, zone_id FROM redev_links")).rows) haveLinks.add(`${r.kind}|${r.ref_id}|${r.zone_id}`);

  const plan = <T extends { key: string; hash: string }>(rows: T[], have: Map<string, string>) => ({
    insert: rows.filter((r) => !have.has(r.key)),
    update: rows.filter((r) => have.has(r.key) && have.get(r.key) !== r.hash),
  });
  const zp = plan(zones, haveZones);
  const pp = plan(projects, haveProjects);
  const newLinks = links.filter((l) => !haveLinks.has(`${l.kind}|${l.ref_id}|${l.zone_id}`));
  const linkKinds: Record<string, number> = {};
  for (const l of newLinks) linkKinds[`${l.kind}:${l.method}`] = (linkKinds[`${l.kind}:${l.method}`] ?? 0) + 1;

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        redev_zones: { source: zones.length, existing: haveZones.size, insert: zp.insert.length, update: zp.update.length },
        redev_projects: { source: projects.length, existing: haveProjects.size, insert: pp.insert.length, update: pp.update.length },
        redev_links: { source: links.length, existing: haveLinks.size, insert: newLinks.length, by_kind: linkKinds },
      },
      null,
      2,
    ),
  );
  if (!apply) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260930_redev.sql"), "utf8");
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
  const upsert = (table: string, cols: readonly string[], source: string, extra: [string, Val][] = []) => {
    const all = [...cols, ...extra.map(([c]) => c), "source", "payload_hash", "loaded_at"];
    const sql = `INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")})
                 ON CONFLICT(${cols[0]}) DO UPDATE SET ${all.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}
                 WHERE ${table}.payload_hash <> excluded.payload_hash`;
    return (r: { vals: Val[]; hash: string }): InStatement => ({ sql, args: [...r.vals, ...extra.map(([, v]) => v), source, r.hash, now] });
  };
  const zoneStmt = upsert("redev_zones", ZONE_COLS, ZONE_SOURCE);
  const projStmt = upsert("redev_projects", PROJECT_COLS, PROJECT_SOURCE, [["base_date", BASE_DATE]]);

  const applied = {
    redev_zones: await run([...zp.insert, ...zp.update].map(zoneStmt)),
    redev_projects: await run([...pp.insert, ...pp.update].map(projStmt)),
    redev_links: await run(
      newLinks.map((l) => ({
        sql: `INSERT OR IGNORE INTO redev_links (kind, ref_id, zone_id, method, detail, linked_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [l.kind, l.ref_id, l.zone_id, l.method, l.detail, now],
      })),
    ),
  };
  console.log(JSON.stringify({ applied }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
