/**
 * 전국도시철도역사정보표준데이터 → rail_stations. 이 테이블 외 쓰기 없음. missing-only (이미 있는 역은 그대로).
 *
 *   python scripts/rail/xlsx-to-json.py "C:/data/rail/전체_도시철도역사정보_20260630.xlsx" C:/data/rail/stations.json
 *   npx tsx scripts/rail/load-stations.ts --from=C:/data/rail/stations.json            # dry-run
 *   npx tsx scripts/rail/load-stations.ts --from=C:/data/rail/stations.json --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../src/lib/db/client";

const SOURCE = "공공데이터포털 전국도시철도역사정보표준데이터 (2026-06-30)";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

type Raw = Record<string, string | null>;

const str = (v: string | null | undefined) => (v == null || v.trim() === "" ? null : v.trim());

/** 기준일자가 엑셀 날짜 일련번호(46022)로 온 행은 날짜로 옮긴다. 나머지는 원문. */
function baseDate(v: string | null): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000).toISOString().slice(0, 10);
  return s;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const from = arg("from");
  if (!from) throw new Error("--from=<json> 이 필요합니다.");
  const apply = process.argv.includes("--apply");

  const raw = JSON.parse(readFileSync(from, "utf8")) as Raw[];
  const rows = new Map<string, (string | number | null)[]>();
  let bad = 0;
  let dup = 0;
  for (const r of raw) {
    const no = str(r["역번호"]);
    const name = str(r["역사명"]);
    const line = str(r["노선명"]);
    const lat = Number(r["역위도"]);
    const lng = Number(r["역경도"]);
    if (!no || !name || !line || !(lat > 33 && lat < 39) || !(lng > 124 && lng < 132)) {
      bad++;
      continue;
    }
    const key = `${no}|${str(r["노선번호"]) ?? ""}|${line}`;
    if (rows.has(key)) {
      dup++;
      continue;
    }
    rows.set(key, [
      key, no, name, str(r["노선번호"]), line, str(r["환승역구분"]), str(r["환승노선명"]),
      lat, lng, str(r["운영기관명"]), str(r["역사도로명주소"]), baseDate(r["데이터기준일자"]),
    ]);
  }

  const exists =
    (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rail_stations'")).rows.length > 0;
  const have = new Set<string>();
  if (exists) for (const r of (await db.execute("SELECT station_key FROM rail_stations")).rows) have.add(String(r.station_key));
  const missing = [...rows.values()].filter((r) => !have.has(String(r[0])));
  console.log(
    JSON.stringify(
      { mode: apply ? "apply" : "dry-run", source_rows: raw.length, valid: rows.size, skipped_bad: bad, skipped_dup: dup, existing: have.size, insert: missing.length },
      null,
      2,
    ),
  );
  if (!apply || missing.length === 0) return;

  const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260929_rail_stations.sql"), "utf8");
  for (const stmt of ddl.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  const now = new Date().toISOString();
  let affected = 0;
  for (let i = 0; i < missing.length; i += 200) {
    const res = await db.batch(
      missing.slice(i, i + 200).map((r) => ({
        sql: `INSERT OR IGNORE INTO rail_stations (station_key, station_no, name, line_no, line_name, transfer_type, transfer_lines,
                lat, lng, operator, road_address, base_date, source, loaded_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [...r, SOURCE, now],
      })),
      "write",
    );
    affected += res.reduce((a, x) => a + x.rowsAffected, 0);
  }
  console.log(JSON.stringify({ applied: affected }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
