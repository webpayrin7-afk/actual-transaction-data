/**
 * 이촌(4호선) 역 좌표 정정 — 원천(전국도시철도역사정보표준데이터)이 신용산역 좌표를 적어 둠.
 * 같은 역인 경의중앙선 이촌역(원천 노선명 '경원선') 행의 좌표로 바꾼다. 수정 전 값은 data/fixes 에 기록.
 *
 *   npx tsx scripts/fixes/fix-rail-ichon.mts           # dry-run
 *   npx tsx scripts/fixes/fix-rail-ichon.mts --apply   # 적용 (다시 돌리면 0건)
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";

config({ path: ".env.local", quiet: true });
const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const apply = process.argv.includes("--apply");

const target = (
  await db.execute(`SELECT station_key, name, line_name, lat, lng FROM rail_stations WHERE station_key = '0430|I1104|4호선'`)
).rows[0];
const ref = (
  await db.execute(`SELECT station_key, name, line_name, lat, lng FROM rail_stations WHERE name = '이촌역' AND line_name = '경원선'`)
).rows;
if (!target || ref.length !== 1) throw new Error("예상과 다른 행 — 중단");
console.log(`현재: ${target.name} ${target.line_name} ${target.lat},${target.lng}`);
console.log(`기준: ${ref[0]!.name} ${ref[0]!.line_name} ${ref[0]!.lat},${ref[0]!.lng}`);

if (Number(target.lat) === Number(ref[0]!.lat) && Number(target.lng) === Number(ref[0]!.lng)) {
  console.log("이미 정정됨 — 0건");
  process.exit(0);
}
if (!apply) {
  console.log("dry-run: 1건 바뀔 예정 (--apply 로 적용)");
  process.exit(0);
}
mkdirSync("data/fixes", { recursive: true });
writeFileSync(
  "data/fixes/rail-stations-ichon-before.json",
  JSON.stringify({ at: new Date().toISOString(), before: target, from: ref[0] }, null, 2),
);
const r = await db.execute({
  sql: `UPDATE rail_stations SET lat = ?, lng = ? WHERE station_key = ? AND lat = ? AND lng = ?`,
  args: [ref[0]!.lat, ref[0]!.lng, target.station_key, target.lat, target.lng],
});
console.log(`적용: ${r.rowsAffected}건 (수정 전 값: data/fixes/rail-stations-ichon-before.json)`);
