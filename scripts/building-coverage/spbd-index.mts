/**
 * 브이월드 SPBD 캐시(C:/data/fixes/gis-spbd/cache, 단지마다 ±700m) → 서울 건물만 중복 없이 한 파일로. 읽기만(네트워크·DB 없음).
 *   npx tsx scripts/building-coverage/spbd-index.mts   → data/building-coverage/cache/spbd-seoul.json
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = "C:/data/fixes/gis-spbd/cache";
const seen = new Map<string, any>();
for (const fn of readdirSync(dir)) {
  const txt = readFileSync(`${dir}/${fn}`, "utf8");
  if (!txt.includes("서울특별시")) continue;
  let arr: any[];
  try { arr = JSON.parse(txt); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const x of arr) if (String(x.sig ?? "").startsWith("서울") && !seen.has(x.bd_mgt_sn)) seen.set(x.bd_mgt_sn, x);
}
writeFileSync("data/building-coverage/cache/spbd-seoul.json", JSON.stringify([...seen.values()]));
console.log("seoul spbd", seen.size);
