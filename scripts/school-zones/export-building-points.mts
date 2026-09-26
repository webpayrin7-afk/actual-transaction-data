/**
 * 통학구역 판정용 단지 점 내보내기 (동별) — 읽기만 (DB 쓰기 없음).
 * 단지 좌표 한 점(주소 점·필지 모서리)은 경계 근처 단지를 옆 구역으로 잘못 넣을 수 있어,
 * 동 외곽선마다 가운데와 넓이를 내보내 build-zones.py 가 넓이로 투표하게 한다.
 * 기준 점(주소 점 complex_map_anchor → 필지 점 apt_complex_master)에서 멀리 떨어진 동은 잘못 이은 옛 필지로 보고 뺀다
 * (동 4개 이하 단지 250m, 그보다 크면 700m). 남는 동이 없거나 외곽선이 없는 단지는 기준 점 한 점.
 *
 *   npx tsx scripts/school-zones/export-building-points.mts --sd=11,41 --out=C:/data/school/work/complex-parts.json
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../../src/lib/db/client";
import { readComplex3d } from "../../src/lib/complex-3d/read";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

type Out = { complex_id: string; sd: string; lat: number; lng: number; src: string; parts?: Array<[number, number, number]> };

/** 외곽선 넓이(㎡)·가운데 — 방향(시계·반시계) 상관없이 */
function part(ring: Array<[number, number]>): [number, number, number] | null {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    const k = x0 * y1 - x1 * y0;
    a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  if (Math.abs(a) < 1e-14) return null;
  const lng = cx / (3 * a), lat = cy / (3 * a);
  const m2 = (Math.abs(a) / 2) * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180);
  return [+lng.toFixed(7), +lat.toFixed(7), Math.round(m2)];
}

async function main() {
  const sds = (arg("sd") ?? "11,41").split(",").filter((s) => /^\d{2}$/.test(s));
  const out = arg("out");
  if (!out) throw new Error("--out=path 필요");
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음");
  const rows = (
    await db.execute({
      sql: `SELECT m.complex_id, substr(m.lawd_cd, 1, 2) AS sd, m.latitude, m.longitude,
                   n.lat AS n_lat, n.lng AS n_lng, t.lat AS t_lat, t.lng AS t_lng
              FROM apt_complex_master m
              LEFT JOIN complex_map_anchor n ON n.complex_id = m.complex_id
              LEFT JOIN complex_3d_anchor t ON t.complex_id = m.complex_id
             WHERE substr(m.lawd_cd, 1, 2) IN (${sds.map(() => "?").join(",")})`,
      args: sds,
    })
  ).rows;
  const res: Out[] = [];
  const stat = { rows: rows.length, parts: 0, dropped: 0, anchor3d: 0, naver: 0, master: 0, noCoord: 0, error: 0 };
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const r = rows[i++]!;
      const id = String(r.complex_id);
      const sd = String(r.sd);
      const pick = (lat: unknown, lng: unknown) =>
        lat != null && lng != null && Number.isFinite(Number(lat)) ? [Number(lat), Number(lng)] : null;
      const one = pick(r.n_lat, r.n_lng) ?? pick(r.latitude, r.longitude);
      const src = pick(r.n_lat, r.n_lng) ? "complex_map_anchor" : "apt_complex_master";
      try {
        const s = await readComplex3d(db, id, { shapesOnly: true });
        const parts = (s?.buildings ?? [])
          .map((b) => (b.rings?.[0] && b.rings[0].length >= 4 ? part(b.rings[0]) : null))
          .filter((p): p is [number, number, number] => p != null && p[2] > 0);
        if (one) {
          const far = parts.length > 4 ? 700 : 250;
          const kx = 111_320 * Math.cos((one[0]! * Math.PI) / 180);
          const keep = parts.filter((q) => Math.hypot((q[0] - one[1]!) * kx, (q[1] - one[0]!) * 111_320) <= far);
          stat.dropped += parts.length - keep.length;
          parts.length = 0;
          parts.push(...keep);
        }
        if (parts.length && one) {
          res.push({ complex_id: id, sd, lat: one[0]!, lng: one[1]!, src: "building_footprints", parts });
          stat.parts++;
          continue;
        }
      } catch {
        stat.error++;
      }
      if (!one) { stat.noCoord++; continue; }
      res.push({ complex_id: id, sd, lat: one[0]!, lng: one[1]!, src });
      stat[src === "complex_map_anchor" ? "naver" : "master"]++;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res));
  console.log(JSON.stringify({ sds, ...stat, out }));
}

await main();
