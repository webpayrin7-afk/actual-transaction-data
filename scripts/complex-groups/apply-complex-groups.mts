/**
 * 단지 묶음(complex group) 적재 — dry-run JSON(dry-run-complex-groups.mts 결과)에서 묶음을 골라
 * complex_group / complex_group_member 에 넣는다. 추가만 (INSERT OR IGNORE). 원본 표는 건드리지 않는다.
 *
 *   npx tsx scripts/complex-groups/apply-complex-groups.mts                       # dry-run: 넣을 행 수만 (DB 쓰기 없음)
 *   npx tsx scripts/complex-groups/apply-complex-groups.mts --apply               # 표 만들기(없으면) + INSERT OR IGNORE
 *   --from=data/complex-groups/dry-run-2026-09-27.json   (기본값)
 *   --approved=<파일>  owner 가 승인한 LIKELY 묶음 group_key 목록(한 줄에 하나) — evidence_class 'OWNER_APPROVED' 로 더한다.
 *                      없으면 CONFIRMED 만.
 *
 * 규칙: dry-run → 건수 확인 → --apply → 다시 --apply = 0행.
 * 멤버가 이미 다른 묶음에 들어 있으면 아무것도 쓰지 않고 멈춘다.
 * 묶음 가운데 점(anchor)은 멤버 동 외곽선(GIS, 3D와 같은 연결 규칙) 전체의 면적가중 중심. 없으면 NULL.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const APPLY = args.includes("--apply");
const FROM = arg("from") ?? "data/complex-groups/dry-run-2026-09-27.json";
const APPROVED = arg("approved");
const RULE_VERSION = "complex-group-v1";
const LOT_RE = /\s*\((\d+(?:-\d+)?)\)\s*$/;
/** 3D 와 같은 규칙 — 대장번호가 같아도 단지 좌표에서 1km 넘는 GIS 건물은 다른 건물 */
const LINK_MAX_M = 1000;

type DryMember = {
  complex_id: string;
  apt_name: string;
  jibun: string | null;
  name_lot: string | null;
  kapt: string[];
  official_households: number | null;
  res_households_sum: number;
  tx: { trade: number; rent: number };
};
type DryGroup = {
  group_key: string;
  lawd_cd: string;
  bjdong_cd: string;
  base_name: string;
  class: string;
  confirmed_components: Array<{ primary_complex_id: string; member_complex_ids: string[] }>;
  members: DryMember[];
  pairs: unknown[];
};

const db = getDb();
if (!db) throw new Error("no db (TURSO_DATABASE_URL)");
if (!existsSync(FROM)) throw new Error(`--from 파일 없음: ${FROM}`);
const dry = JSON.parse(readFileSync(FROM, "utf8")) as { groups: DryGroup[] };
const approvedKeys = APPROVED
  ? new Set(readFileSync(APPROVED, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  : new Set<string>();

/** 대표 고르기 (설계와 같음): K-apt 있는 멤버 > 공식 총세대 큰 > 주거동 세대 합 큰 > 매매 건수 많은 */
function pickPrimary(ms: DryMember[]): string {
  return [...ms].sort(
    (a, b) =>
      Number(b.kapt.length > 0) - Number(a.kapt.length > 0) ||
      (b.official_households ?? 0) - (a.official_households ?? 0) ||
      b.res_households_sum - a.res_households_sum ||
      b.tx.trade - a.tx.trade,
  )[0]!.complex_id;
}

type Plan = {
  group_id: string;
  group_key: string;
  primary: string;
  members: DryMember[];
  display_name: string;
  lawd_cd: string;
  bjdong_cd: string;
  household_count: number | null;
  evidence_class: "CONFIRMED" | "OWNER_APPROVED";
  evidence_json: string;
  anchor: [number, number] | null;
  anchor_buildings: number;
};

const plans: Plan[] = [];
for (const g of dry.groups) {
  let cls: Plan["evidence_class"] | null = null;
  let comps: Array<{ primary: string; ids: string[] }> = [];
  if (g.class === "CONFIRMED") {
    cls = "CONFIRMED";
    comps = g.confirmed_components.map((c) => ({ primary: c.primary_complex_id, ids: c.member_complex_ids }));
  } else if (approvedKeys.has(g.group_key)) {
    cls = "OWNER_APPROVED";
    comps = [{ primary: pickPrimary(g.members), ids: g.members.map((m) => m.complex_id) }];
  }
  if (!cls) continue;
  for (const c of comps) {
    const members = g.members.filter((m) => c.ids.includes(m.complex_id));
    if (members.length < 2) continue;
    const official = Math.max(0, ...members.map((m) => m.official_households ?? 0));
    const resSum = members.reduce((s, m) => s + (m.res_households_sum || 0), 0);
    plans.push({
      group_id: `cg_${c.primary.slice(-16)}`,
      group_key: g.group_key,
      primary: c.primary,
      members,
      display_name: g.base_name,
      lawd_cd: g.lawd_cd,
      bjdong_cd: g.bjdong_cd,
      household_count: official > 0 ? official : resSum > 0 ? resSum : null,
      evidence_class: cls,
      evidence_json: JSON.stringify({
        group_key: g.group_key,
        class: g.class,
        members: members.map((m) => ({
          complex_id: m.complex_id,
          apt_name: m.apt_name,
          jibun: m.jibun,
          kapt: m.kapt,
          official_households: m.official_households,
          res_households_sum: m.res_households_sum,
        })),
        pairs: g.pairs,
      }),
      anchor: null,
      anchor_buildings: 0,
    });
  }
}
if (!plans.length) {
  console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY_RUN", groups: 0, note: "넣을 묶음 없음" }));
  process.exit(0);
}

// ── 묶음 가운데 점: 멤버 동 외곽선(GIS) 전체의 면적가중 중심 (scripts/map-anchor/build-3d-anchors.mts 와 같은 식) ──
type Ring = Array<[number, number]>;
function center(rings: Ring[]): [number, number] | null {
  let sx = 0, sy = 0, sw = 0;
  for (const ring of rings) {
    const [ox, oy] = ring[0]!;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
      const x0 = ring[i]![0] - ox, y0 = ring[i]![1] - oy;
      const x1 = ring[(i + 1) % ring.length]![0] - ox, y1 = ring[(i + 1) % ring.length]![1] - oy;
      const k = x0 * y1 - x1 * y0;
      a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    }
    if (Math.abs(a) < 1e-14) continue;
    const sg = Math.sign(a);
    sx += (cx / 3) * sg + ox * Math.abs(a); sy += (cy / 3) * sg + oy * Math.abs(a); sw += Math.abs(a);
  }
  return sw ? [sx / sw, sy / sw] : null;
}
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, r = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const allIds = plans.flatMap((p) => p.members.map((m) => m.complex_id));
const ph = (n: number) => Array(n).fill("?").join(",");
const gisRows = (
  await db.execute({
    sql: `SELECT b.complex_id, g.bld_key, g.rings, g.lat, g.lng,
                 COALESCE(a.lat, m.latitude) AS c_lat, COALESCE(a.lng, m.longitude) AS c_lng
          FROM complex_buildings b
          JOIN apt_complex_master m ON m.complex_id = b.complex_id
          LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
          JOIN gis_buildings g ON g.lawd_cd = m.lawd_cd AND g.bldrgst_pk = substr(b.mgm_bldrgst_pk, 6)
          WHERE b.complex_id IN (${ph(allIds.length)}) AND length(b.mgm_bldrgst_pk) > 5
            AND g.rings IS NOT NULL AND g.rings <> 'null'`,
    args: allIds,
  })
).rows;
for (const p of plans) {
  const ids = new Set(p.members.map((m) => m.complex_id));
  const seen = new Set<string>();
  const rings: Ring[] = [];
  for (const r of gisRows) {
    if (!ids.has(String(r.complex_id)) || seen.has(String(r.bld_key))) continue;
    if (haversine(Number(r.c_lat), Number(r.c_lng), Number(r.lat), Number(r.lng)) > LINK_MAX_M) continue;
    const ring = (JSON.parse(String(r.rings)) as Ring[])[0];
    if (!ring || ring.length < 4) continue;
    seen.add(String(r.bld_key));
    rings.push(ring);
  }
  const c = center(rings);
  p.anchor = c ? [+c[1].toFixed(7), +c[0].toFixed(7)] : null;
  p.anchor_buildings = rings.length;
}

// ── 이미 다른 묶음에 들어 있는 멤버가 있으면 멈춘다 ──
let existing: Array<Record<string, unknown>> = [];
let existingGroups = new Set<string>();
try {
  existingGroups = new Set(
    (
      await db.execute({
        sql: `SELECT group_id FROM complex_group WHERE group_id IN (${ph(plans.length)})`,
        args: plans.map((p) => p.group_id),
      })
    ).rows.map((r) => String(r.group_id)),
  );
  existing = (
    await db.execute({
      sql: `SELECT complex_id, group_id, role FROM complex_group_member WHERE complex_id IN (${ph(allIds.length)})`,
      args: allIds,
    })
  ).rows as Array<Record<string, unknown>>;
} catch (e) {
  if (!/no such table/i.test(String(e))) throw e; // 표가 아직 없음 = 들어 있는 멤버 없음
}
const conflicts = existing.filter((r) => {
  const p = plans.find((x) => x.members.some((m) => m.complex_id === String(r.complex_id)))!;
  const role = String(r.complex_id) === p.primary ? "PRIMARY" : "MEMBER";
  return String(r.group_id) !== p.group_id || String(r.role) !== role;
});
if (conflicts.length) {
  console.error(JSON.stringify({ stop: "MEMBER_ALREADY_IN_OTHER_GROUP", conflicts }, null, 2));
  process.exit(2);
}
const already = new Set(existing.map((r) => String(r.complex_id)));

const now = new Date().toISOString();
const stmts = plans.flatMap((p) => [
  {
    sql: `INSERT OR IGNORE INTO complex_group (group_id, primary_complex_id, display_name, lawd_cd, bjdong_cd, household_count,
            anchor_lat, anchor_lng, evidence_class, evidence_json, rule_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.group_id, p.primary, p.display_name, p.lawd_cd, p.bjdong_cd, p.household_count,
      p.anchor?.[0] ?? null, p.anchor?.[1] ?? null, p.evidence_class, p.evidence_json, RULE_VERSION, now, now,
    ],
  },
  ...p.members.map((m) => ({
    sql: `INSERT OR IGNORE INTO complex_group_member (complex_id, group_id, role, lot_label, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [m.complex_id, p.group_id, m.complex_id === p.primary ? "PRIMARY" : "MEMBER", m.name_lot ?? LOT_RE.exec(m.apt_name)?.[1] ?? m.jibun, now],
  })),
]);

const summary = {
  mode: APPLY ? "APPLY" : "DRY_RUN",
  from: FROM,
  groups: plans.length,
  members: allIds.length,
  members_already_in_place: already.size,
  would_insert: { complex_group: plans.length - existingGroups.size, complex_group_member: allIds.length - already.size },
  plans: plans.map((p) => ({
    group_id: p.group_id,
    display_name: p.display_name,
    evidence_class: p.evidence_class,
    primary: p.primary,
    members: p.members.map((m) => `${m.complex_id} ${m.apt_name}`),
    household_count: p.household_count,
    anchor: p.anchor,
    anchor_buildings: p.anchor_buildings,
  })),
};

if (!APPLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20261004_complex_group.sql"), "utf8");
await db.executeMultiple(ddl);
const res = await db.batch(stmts, "write");
let groupRows = 0;
let memberRows = 0;
res.forEach((r, i) => {
  if (/INTO complex_group_member/.test(String(stmts[i]!.sql))) memberRows += r.rowsAffected;
  else groupRows += r.rowsAffected;
});
const totals = (
  await db.execute(`SELECT (SELECT count(*) FROM complex_group) AS g, (SELECT count(*) FROM complex_group_member) AS m`)
).rows[0]!;
console.log(
  JSON.stringify(
    {
      ...summary,
      plans: undefined,
      inserted: { complex_group: groupRows, complex_group_member: memberRows },
      table_rows: { complex_group: Number(totals.g), complex_group_member: Number(totals.m) },
    },
    null,
    2,
  ),
);
