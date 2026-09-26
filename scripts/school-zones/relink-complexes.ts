/**
 * 단지 → 통학구역 다시 잇기 (동 넓이 투표 결과로) — complex_elem_school_zones 만 쓴다.
 * load-zones.ts 는 없는 것만 넣고 있는 행은 안 고친다. 판정 방식을 바꿨을 때(한 점 → 동별 넓이 투표) 이 스크립트로 차이만 반영한다.
 *
 *   npx tsx scripts/school-zones/relink-complexes.ts --in=C:/data/school/work/zones-11-41-parts.json            # dry-run
 *   npx tsx scripts/school-zones/relink-complexes.ts --in=C:/data/school/work/zones-11-41-parts.json --apply    # 다시 돌리면 0
 *
 * - 새 결과에 없는 (단지, 구역) 행은 지운다 (판정 대상 시도 안의 단지만).
 * - 새로 생긴 행은 넣고, 좌표·출처·비율이 달라진 행만 고친다.
 * - share 열(동 넓이 중 그 구역에 든 비율)이 없으면 더한다 (ALTER TABLE ADD COLUMN — 기존 열은 그대로).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import type { InStatement } from "@libsql/client";
import { getDb } from "../../src/lib/db/client";

type Link = { complex_id: string; zone_id: string; zone_kind: string; lat: number; lng: number; src: string; share?: number };
type Built = { stats: { sds: string[] }; zones: Array<{ zone_id: string; zone_name: string; base_date: string }>; links: Link[] };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const inFile = arg("in");
  const apply = process.argv.includes("--apply");
  if (!inFile) throw new Error("--in=path 필요");
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음");
  const built = JSON.parse(readFileSync(inFile, "utf8")) as Built;
  const zoneName = new Map(built.zones.map((z) => [z.zone_id, z.zone_name]));
  const base = built.zones[0]!.base_date;
  const sds = built.stats.sds;

  const cols = (await db.execute("PRAGMA table_info(complex_elem_school_zones)")).rows.map((r) => String(r.name));
  const hasShare = cols.includes("share");
  const have = new Map<string, { lat: number; lng: number; src: string; share: number | null }>();
  for (const r of (
    await db.execute({
      sql: `SELECT l.complex_id, l.zone_id, l.point_lat, l.point_lng, l.point_source${hasShare ? ", l.share" : ""}
              FROM complex_elem_school_zones l JOIN apt_complex_master m ON m.complex_id = l.complex_id
             WHERE substr(m.lawd_cd, 1, 2) IN (${sds.map(() => "?").join(",")})`,
      args: sds,
    })
  ).rows)
    have.set(`${r.complex_id}|${r.zone_id}`, {
      lat: Number(r.point_lat),
      lng: Number(r.point_lng),
      src: String(r.point_source),
      share: hasShare && r.share != null ? Number(r.share) : null,
    });
  const next = new Map(built.links.map((l) => [`${l.complex_id}|${l.zone_id}`, l]));

  const del = [...have.keys()].filter((k) => !next.has(k));
  const ins = [...next.values()].filter((l) => !have.has(`${l.complex_id}|${l.zone_id}`));
  const upd = [...next.values()].filter((l) => {
    const h = have.get(`${l.complex_id}|${l.zone_id}`);
    return h && (Math.abs(h.lat - l.lat) > 1e-7 || Math.abs(h.lng - l.lng) > 1e-7 || h.src !== l.src || h.share !== (l.share ?? null));
  });
  // 배정 구역이 실제로 바뀐 단지 (좌표만 바뀐 건 빼고)
  const changed = new Set([...del.map((k) => k.split("|")[0]!), ...ins.map((l) => l.complex_id)]);
  const names = new Map<string, string>();
  const sample = [...changed].slice(0, 400);
  if (sample.length)
    for (const r of (
      await db.execute({ sql: `SELECT complex_id, apt_name FROM apt_complex_master WHERE complex_id IN (${sample.map(() => "?").join(",")})`, args: sample })
    ).rows)
      names.set(String(r.complex_id), String(r.apt_name));
  const examples = sample.slice(0, 25).map((id) => ({
    apt: names.get(id),
    before: del.filter((k) => k.startsWith(`${id}|`)).map((k) => zoneName.get(k.split("|")[1]!) ?? k.split("|")[1]),
    after: ins.filter((l) => l.complex_id === id).map((l) => `${zoneName.get(l.zone_id)} (${Math.round((l.share ?? 1) * 100)}%)`),
  }));
  console.log(
    JSON.stringify(
      { mode: apply ? "apply" : "dry-run", existing: have.size, next: next.size, delete: del.length, insert: ins.length, update: upd.length, complexes_changed: changed.size, examples },
      null,
      2,
    ),
  );
  if (!apply) return;

  if (!hasShare) await db.execute("ALTER TABLE complex_elem_school_zones ADD COLUMN share REAL");
  const now = new Date().toISOString();
  const stmts: InStatement[] = [
    ...del.map((k) => {
      const [c, z] = k.split("|");
      return { sql: "DELETE FROM complex_elem_school_zones WHERE complex_id = ? AND zone_id = ?", args: [c!, z!] };
    }),
    ...ins.map((l) => ({
      sql: `INSERT OR IGNORE INTO complex_elem_school_zones (complex_id, zone_id, zone_kind, point_lat, point_lng, point_source, zone_base_date, computed_at, share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [l.complex_id, l.zone_id, l.zone_kind, l.lat, l.lng, l.src, base, now, l.share ?? null],
    })),
    ...upd.map((l) => ({
      sql: `UPDATE complex_elem_school_zones SET point_lat = ?, point_lng = ?, point_source = ?, share = ?, computed_at = ?
            WHERE complex_id = ? AND zone_id = ?`,
      args: [l.lat, l.lng, l.src, l.share ?? null, now, l.complex_id, l.zone_id],
    })),
  ];
  let affected = 0;
  for (let i = 0; i < stmts.length; i += 200) affected += (await db.batch(stmts.slice(i, i + 200), "write")).reduce((a, x) => a + x.rowsAffected, 0);
  console.log(JSON.stringify({ applied: affected }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
