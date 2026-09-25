/**
 * Parcel relink, step 1 (read-only): export DB state for complexes whose supply fill was held
 * because the parcel could not be resolved.
 *
 * Universe: no-trade targets (data/poc/supply/nt-pnu-cadastre.jsonl) and G2 complexes
 * (data/poc/supply/g2-pnu-cadastre.jsonl). The hold reason is computed later (candidates.py);
 * here every complex that could carry a parcel hold is exported with:
 *   anchor (complex_map_anchor), master coordinates / jibun, K-apt household count,
 *   canonical unit rows, exclusive pairs (trade exclusives), checkpoint details.
 * Also every PNU already owned by a complex (complex_parcel_coordinates) for the shared-parcel check.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/relink/export.mts OUT_DIR IDS844.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const OUT = process.argv[2]!;
const IDS844 = new Set<string>(JSON.parse(readFileSync(process.argv[3]!, "utf8")));
const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => (v == null ? null : typeof v === "bigint" ? Number(v) : Number(v));
const readJsonl = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const nt = readJsonl("data/poc/supply/nt-pnu-cadastre.jsonl").map((r) => ({ ...r, kind: "nt" }));
const g2 = readJsonl("data/poc/supply/g2-pnu-cadastre.jsonl").map((r) => ({ ...r, kind: "g2" }));
const all = [...nt, ...g2];
const ids = [...new Set(all.map((r) => r.complexId as string))];

type Info = Record<string, unknown>;
const info = new Map<string, Info>();
for (const id of ids) info.set(id, { complexId: id, canonical: [], pairs: [] });
async function each(sql: string, fn: (row: Record<string, unknown>) => void) {
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300);
    const res = await db.execute({ sql: sql.replace("$IDS", part.map(() => "?").join(",")), args: part });
    for (const row of res.rows) fn(row as Record<string, unknown>);
  }
}
await each(
  `SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun, legal_dong_name, road_address, latitude, longitude, sido, sigungu
   FROM apt_complex_master WHERE complex_id IN ($IDS)`,
  (r) => {
    Object.assign(info.get(str(r.complex_id))!, {
      aptName: str(r.apt_name), lawdCd: str(r.lawd_cd), bjdongCd: str(r.bjdong_cd), jibun: str(r.jibun),
      dong: str(r.legal_dong_name), roadAddress: str(r.road_address), sido: str(r.sido), sigungu: str(r.sigungu),
      masterLat: num(r.latitude), masterLng: num(r.longitude),
    });
  },
);
await each(`SELECT complex_id, lat, lng, source, query_kind, matched_jibun, parcel_distance_m FROM complex_map_anchor WHERE complex_id IN ($IDS)`, (r) => {
  Object.assign(info.get(str(r.complex_id))!, {
    anchorLat: num(r.lat), anchorLng: num(r.lng), anchorSource: `${str(r.source)}:${str(r.query_kind)}`,
    anchorJibun: str(r.matched_jibun), anchorParcelDistance: num(r.parcel_distance_m),
  });
});
await each(`SELECT complex_id, household_count FROM apt_complex_profile WHERE complex_id IN ($IDS)`, (r) => {
  info.get(str(r.complex_id))!.kaptHouseholds = num(r.household_count);
});
await each(
  `SELECT complex_id, exclusive_cents, supply_cents, status, provenance_json LIKE '%supply_fill_relink_%' AS ours
   FROM apt_canonical_unit_types WHERE complex_id IN ($IDS)`,
  (r) => {
    (info.get(str(r.complex_id))!.canonical as unknown[]).push([num(r.exclusive_cents), num(r.supply_cents), str(r.status), num(r.ours)]);
  },
);
await each(`SELECT complex_id, exclusive_cents, trade_count, trade_count_3y FROM apt_unit_exclusive_pairs WHERE complex_id IN ($IDS)`, (r) => {
  (info.get(str(r.complex_id))!.pairs as unknown[]).push([num(r.exclusive_cents), num(r.trade_count), num(r.trade_count_3y)]);
});
await each(`SELECT complex_id, detail FROM complex_building_checkpoint WHERE complex_id IN ($IDS)`, (r) => {
  info.get(str(r.complex_id))!.buildingCheckpoint = str(r.detail).slice(0, 120);
});
await each(`SELECT complex_id, detail FROM official_unit_area_checkpoint WHERE complex_id IN ($IDS)`, (r) => {
  info.get(str(r.complex_id))!.unitAreaCheckpoint = str(r.detail).slice(0, 120);
});

const rows = all.map((r) => ({
  kind: r.kind,
  in844: IDS844.has(r.complexId),
  phase3: {
    identityStatus: r.identityStatus, cadastre: r.cadastre, cadastrePnu: r.cadastrePnu,
    registryPnus: r.registryPnus ?? (r.pnu ? [r.pnu] : []), pnuOwners: r.pnuOwners ?? null, t3y: r.t3y ?? 0, trades: r.trades ?? 0,
  },
  ...info.get(r.complexId),
}));
writeFileSync(`${OUT}/universe.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const owners = await db.execute(`SELECT complex_id, pnu FROM complex_parcel_coordinates`);
writeFileSync(`${OUT}/pnu-owners-db.json`, JSON.stringify(owners.rows.map((r) => [str(r.complex_id), str(r.pnu)])));
const remap = await db.execute(
  `SELECT 'building' t, COUNT(*) n FROM complex_building_checkpoint WHERE detail LIKE '%bjdong remap 2026-09-25%'
   UNION ALL SELECT 'unit_area', COUNT(*) FROM official_unit_area_checkpoint WHERE detail LIKE '%bjdong remap 2026-09-25%'`,
);
console.log(JSON.stringify({ universe: rows.length, nt: nt.length, g2: g2.length, in844: rows.filter((r) => r.in844).length, owners: owners.rows.length, remapCheckpoints: remap.rows }));
