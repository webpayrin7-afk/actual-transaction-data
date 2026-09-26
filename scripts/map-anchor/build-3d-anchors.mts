/**
 * 3D 지도 단지 점 자리 — 동 외곽선의 가운데(면적 가중)와 가장 높은 동 높이.
 * 2D 지도의 NAVER 주소 점(complex_map_anchor)과 따로: 3D에서는 점을 건물 덩어리 가운데 지붕 위에 띄운다.
 *
 *   npx tsx scripts/map-anchor/build-3d-anchors.mts                         # dry-run: JSONL + 요약, DB 쓰기 없음
 *   npx tsx scripts/map-anchor/build-3d-anchors.mts --apply --from=<jsonl>  # 없는 것만 넣기 (INSERT OR IGNORE)
 *   npx tsx scripts/map-anchor/build-3d-anchors.mts --all                     # 이미 있는 단지도 다시 계산 (dry-run)
 *   npx tsx scripts/map-anchor/build-3d-anchors.mts --update --from=<jsonl> # 값이 달라진 행만 고치기 (다시 돌리면 0)
 *
 * 규칙: dry-run → 건수 확인 → apply → 다시 apply = 0.
 * - 외곽선이 있는 동만. 가운데가 단지 좌표에서 FAR_M 넘게 떨어지면 잘못 이은 필지로 보고 넣지 않는다.
 * - 높이: 동 높이(없으면 층수×3m)의 최댓값. 둘 다 없으면 넣지 않는다.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { readComplex3d } from "../../src/lib/complex-3d/read";

const FAR_M = 300;
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

function loadEnv() {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
}
const db = (): Client => createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

type Row = { complex_id: string; lat: number; lng: number; top_m: number; buildings: number; dist_m: number };

function center(rings: Array<Array<[number, number]>>): [number, number] | null {
  let sx = 0, sy = 0, sw = 0;
  for (const ring of rings) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[i + 1]!;
      const k = x0 * y1 - x1 * y0;
      a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    }
    if (Math.abs(a) < 1e-14) continue;
    // 외곽선 방향(시계·반시계)이 섞여도 되게 — 넓이는 절댓값으로 가중
    const sg = Math.sign(a);
    sx += (cx / 3) * sg; sy += (cy / 3) * sg; sw += Math.abs(a);
  }
  return sw ? [sx / sw, sy / sw] : null;
}

async function dryRun() {
  const client = db();
  const all = args.includes("--all");
  const ids = (
    await client.execute(
      all ? `SELECT complex_id FROM apt_complex_master WHERE lawd_cd LIKE '11%' AND latitude IS NOT NULL` :
      `SELECT m.complex_id FROM apt_complex_master m
       WHERE m.lawd_cd LIKE '11%' AND m.latitude IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM complex_3d_anchor a WHERE a.complex_id = m.complex_id)`,
    ).catch(() => client.execute(`SELECT complex_id FROM apt_complex_master WHERE lawd_cd LIKE '11%' AND latitude IS NOT NULL`))
  ).rows.map((r) => String(r.complex_id));
  const file = `data/map-anchor/3d-anchors-${new Date().toISOString().slice(0, 10)}.jsonl`;
  writeFileSync(file, "");
  const counts = { candidates: ids.length, ok: 0, no_shape: 0, no_height: 0, far: 0, error: 0 };
  let i = 0;
  const out: string[] = [];
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++]!;
      try {
        const s = await readComplex3d(client, id, { shapesOnly: true });
        const withRings = (s?.buildings ?? []).filter((b) => b.rings?.[0] && b.rings[0].length >= 4);
        const c = center(withRings.map((b) => b.rings![0]!));
        if (!s || !c) { counts.no_shape++; continue; }
        const top = Math.max(0, ...withRings.map((b) => (b.heightM && b.heightM > 0 ? b.heightM : b.floors && b.floors > 0 ? b.floors * 3 : 0)));
        if (!top) { counts.no_height++; continue; }
        const dist = Math.hypot((c[0] - s.center.lng) * 111_320 * Math.cos((s.center.lat * Math.PI) / 180), (c[1] - s.center.lat) * 111_320);
        if (dist > FAR_M) { counts.far++; continue; }
        counts.ok++;
        const row: Row = { complex_id: id, lat: +c[1].toFixed(7), lng: +c[0].toFixed(7), top_m: +top.toFixed(1), buildings: withRings.length, dist_m: Math.round(dist) };
        out.push(JSON.stringify(row));
      } catch {
        counts.error++;
      }
      if ((counts.ok + counts.no_shape + counts.no_height + counts.far + counts.error) % 500 === 0) console.log(JSON.stringify(counts));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  writeFileSync(file, out.join("\n") + "\n");
  console.log(JSON.stringify({ file, ...counts, would_insert: counts.ok }, null, 2));
}

async function update() {
  const from = arg("from");
  if (!from || !existsSync(from)) throw new Error("--update needs --from=<dry-run .jsonl>");
  const client = db();
  const rows: Row[] = [];
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line) as Row);
  const now = new Date().toISOString();
  let updated = 0;
  for (let k = 0; k < rows.length; k += 200) {
    const res = await client.batch(
      rows.slice(k, k + 200).map((r) => ({
        sql: `UPDATE complex_3d_anchor SET lat = ?, lng = ?, top_m = ?, buildings = ?, computed_at = ?
              WHERE complex_id = ? AND (abs(lat - ?) > 1e-7 OR abs(lng - ?) > 1e-7 OR top_m <> ? OR buildings <> ?)`,
        args: [r.lat, r.lng, r.top_m, r.buildings, now, r.complex_id, r.lat, r.lng, r.top_m, r.buildings],
      })),
      "write",
    );
    updated += res.reduce((s, x) => s + x.rowsAffected, 0);
  }
  console.log(JSON.stringify({ from, rows_in_file: rows.length, updated }, null, 2));
}

async function apply() {
  const from = arg("from");
  if (!from || !existsSync(from)) throw new Error("--apply needs --from=<dry-run .jsonl>");
  const client = db();
  await client.execute(`CREATE TABLE IF NOT EXISTS complex_3d_anchor (
    complex_id TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    top_m REAL NOT NULL,
    buildings INTEGER NOT NULL,
    source TEXT NOT NULL,
    computed_at TEXT NOT NULL
  )`);
  const rows: Row[] = [];
  const rl = createInterface({ input: createReadStream(from), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) rows.push(JSON.parse(line) as Row);
  const now = new Date().toISOString();
  let inserted = 0;
  for (let k = 0; k < rows.length; k += 200) {
    const res = await client.batch(
      rows.slice(k, k + 200).map((r) => ({
        sql: `INSERT OR IGNORE INTO complex_3d_anchor (complex_id, lat, lng, top_m, buildings, source, computed_at)
              VALUES (?, ?, ?, ?, ?, 'COMPLEX_BUILDING_FOOTPRINTS', ?)`,
        args: [r.complex_id, r.lat, r.lng, r.top_m, r.buildings, now],
      })),
      "write",
    );
    inserted += res.reduce((s, x) => s + x.rowsAffected, 0);
  }
  const total = (await client.execute("SELECT count(*) AS n FROM complex_3d_anchor")).rows[0]!.n;
  console.log(JSON.stringify({ from, rows_in_file: rows.length, inserted, table_rows: Number(total) }, null, 2));
}

loadEnv();
await (args.includes("--update") ? update() : args.includes("--apply") ? apply() : dryRun());
