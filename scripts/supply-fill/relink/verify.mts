/**
 * Parcel relink, step 6 (read-only): state of the relink targets after apply.
 * Full supply = at least one positive supply row and no NO_SOURCE row.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/relink/verify.mts WORK_DIR
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const WORK = process.argv[2]!;
const RECOVERIES = ["supply_fill_relink_nt_2026_09", "supply_fill_relink_g2_2026_09"];
const db = createClient({ url: process.env.TURSO_DATABASE_URL!.trim(), authToken: process.env.TURSO_AUTH_TOKEN!.trim() });
const rows = readFileSync(`${WORK}/accept.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const accepted = rows.filter((r) => r.decision === "ACCEPTED");
const ids = accepted.map((r) => r.complexId as string);
const state = new Map<string, { supplied: number; noSource: number; ours: number; t3y: number; lawdCd: string; sigungu: string }>();
for (let i = 0; i < ids.length; i += 300) {
  const part = ids.slice(i, i + 300);
  const ph = part.map(() => "?").join(",");
  const res = await db.execute({
    sql: `SELECT m.complex_id, m.lawd_cd, m.sigungu,
            (SELECT COUNT(*) FROM apt_canonical_unit_types u WHERE u.complex_id = m.complex_id AND u.supply_cents >= 0) supplied,
            (SELECT COUNT(*) FROM apt_canonical_unit_types u WHERE u.complex_id = m.complex_id AND u.status = 'NO_SOURCE') no_source,
            (SELECT COUNT(*) FROM apt_canonical_unit_types u WHERE u.complex_id = m.complex_id
               AND (${RECOVERIES.map(() => "u.provenance_json LIKE ?").join(" OR ")})) ours,
            (SELECT COALESCE(SUM(trade_count_3y), 0) FROM apt_unit_exclusive_pairs p WHERE p.complex_id = m.complex_id) t3y
          FROM apt_complex_master m WHERE m.complex_id IN (${ph})`,
    args: [...RECOVERIES.map((r) => `%${r}%`), ...part],
  });
  for (const r of res.rows) {
    state.set(String(r.complex_id), { supplied: Number(r.supplied), noSource: Number(r.no_source), ours: Number(r.ours),
      t3y: Number(r.t3y), lawdCd: String(r.lawd_cd), sigungu: String(r.sigungu ?? "") });
  }
}
const out = { accepted: accepted.length, touched: 0, full: 0, full3y: 0, byKind: {} as Record<string, Record<string, number>>, lawdCodes: {} as Record<string, number> };
for (const r of accepted) {
  const s = state.get(r.complexId);
  if (!s) continue;
  const k = (out.byKind[r.kind] ??= { accepted: 0, touched: 0, full: 0, full3y: 0 });
  k.accepted += 1;
  if (s.ours > 0) {
    out.touched += 1;
    k.touched += 1;
    out.lawdCodes[s.lawdCd] = (out.lawdCodes[s.lawdCd] ?? 0) + 1;
    if (s.supplied > 0 && s.noSource === 0) {
      out.full += 1;
      k.full += 1;
      if (s.t3y > 0) {
        out.full3y += 1;
        k.full3y += 1;
      }
    }
  }
}
writeFileSync(`${WORK}/verify.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
