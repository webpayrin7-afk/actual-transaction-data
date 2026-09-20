import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { parseParcelJibun, parcelPnu } from "../../src/lib/unit-type/official-expos";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});

const kapt = await db.execute(`
  SELECT l.complex_id, l.source_meta_json
  FROM apt_complex_source_links l
  JOIN apt_unit_acquisition_manifest m ON m.complex_id = l.complex_id
  WHERE l.source = 'KAPT' AND (m.jibun IS NULL OR m.jibun = '')
`);
const kaptJibun = new Map<string, string>();
for (const row of kapt.rows) {
  try {
    const meta = JSON.parse(String(row.source_meta_json ?? "{}")) as { jibun?: string };
    if (meta.jibun) kaptJibun.set(String(row.complex_id), meta.jibun);
  } catch {}
}

const rows = await db.execute(`
  SELECT m.complex_id, m.apt_name, m.lawd_cd, m.bjdong_cd, m.jibun, m.blocker_class,
         COALESCE(t.c12, 0) AS c12
  FROM apt_unit_acquisition_manifest m
  LEFT JOIN (
    SELECT complex_id, SUM(trade_count_12m) AS c12 FROM apt_unit_exclusive_pairs GROUP BY complex_id
  ) t ON t.complex_id = m.complex_id
`);

const out: Array<Record<string, unknown>> = [];
let parseOk = 0;
let parseFail = 0;
const parcelCounts = new Map<string, number>();
for (const row of rows.rows) {
  const complexId = String(row.complex_id);
  const jibun = String(row.jibun || "") || kaptJibun.get(complexId) || "";
  const parcel = parseParcelJibun(jibun);
  if (!parcel || !row.bjdong_cd) {
    parseFail += 1;
    out.push({
      complexId,
      aptName: String(row.apt_name),
      lawdCd: String(row.lawd_cd),
      bjdongCd: String(row.bjdong_cd || ""),
      jibun,
      recent: Number(row.c12 || 0),
      parcelKey: null,
      pnu: null,
      blocker: String(row.blocker_class || ""),
    });
    continue;
  }
  parseOk += 1;
  const parcelKey = `${row.lawd_cd}|${row.bjdong_cd}|${parcel.platGbCd}|${parcel.bun}|${parcel.ji}`;
  parcelCounts.set(parcelKey, (parcelCounts.get(parcelKey) ?? 0) + 1);
  out.push({
    complexId,
    aptName: String(row.apt_name),
    lawdCd: String(row.lawd_cd),
    bjdongCd: String(row.bjdong_cd),
    jibun,
    recent: Number(row.c12 || 0),
    parcelKey,
    pnu: parcelPnu(String(row.lawd_cd), String(row.bjdong_cd), parcel.platGbCd, parcel.bun, parcel.ji),
    platGbCd: parcel.platGbCd,
    bun: parcel.bun,
    ji: parcel.ji,
    blocker: String(row.blocker_class || ""),
  });
}
const multi = [...parcelCounts.values()].filter((n) => n > 1).length;
writeFileSync("/tmp/building-hub-bulk/manifest-parcels.jsonl", out.map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(JSON.stringify({ total: out.length, parseOk, parseFail, uniqueParcels: parcelCounts.size, multiParcels: multi }));
