import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { parseParcelJibun, parcelPnu } from "../../src/lib/unit-type/official-expos";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});
const names = [
  "잠실엘스",
  "파크리오",
  "리센츠",
  "헬리오시티",
  "반포자이",
  "래미안퍼스티지",
  "은마",
  "도곡렉슬",
  "마포프레스티지자이",
  "포레나노원",
];
const rows = await db.execute(
  `SELECT complex_id, apt_name, apt_name_norm, lawd_cd, bjdong_cd, jibun
   FROM apt_complex_master
   WHERE apt_name_norm IN (${names.map((n) => `'${n}'`).join(",")})`,
);
const out = [];
for (const row of rows.rows) {
  const parcel = parseParcelJibun(String(row.jibun || ""));
  const item = {
    complexId: String(row.complex_id),
    aptName: String(row.apt_name),
    lawdCd: String(row.lawd_cd),
    bjdongCd: String(row.bjdong_cd || ""),
    jibun: String(row.jibun || ""),
    recent: 1,
    parcelKey: parcel
      ? `${row.lawd_cd}|${row.bjdong_cd}|${parcel.platGbCd}|${parcel.bun}|${parcel.ji}`
      : null,
    pnu: parcel
      ? parcelPnu(String(row.lawd_cd), String(row.bjdong_cd), parcel.platGbCd, parcel.bun, parcel.ji)
      : null,
    platGbCd: parcel?.platGbCd,
    bun: parcel?.bun,
    ji: parcel?.ji,
  };
  out.push(item);
  console.log(item);
}
writeFileSync("/tmp/building-hub-bulk/pilot-parcels.jsonl", out.map((x) => JSON.stringify(x)).join("\n") + "\n");
const ids = out.map((o) => `'${o.complexId}'`).join(",");
const inManifest = await db.execute(`SELECT complex_id FROM apt_unit_acquisition_manifest WHERE complex_id IN (${ids})`);
console.log("in manifest", inManifest.rows);
