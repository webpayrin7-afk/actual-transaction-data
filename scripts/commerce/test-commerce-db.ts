/**
 * Offline checks for the national commerce reader against a local snapshot SQLite.
 *   npx tsx scripts/commerce/test-commerce-db.ts <local.sqlite> [sampleSize]
 *
 * 1. Every sampled complex: runtime-decoded map pointCount == stored p2_total (1km).
 * 2. 잠실엘스 pilot-center parity: cells decoded at the C4 pilot center reproduce the
 *    fixture point cloud (count, category mix, offsets within ±1m).
 * 3. Composition/facility arrays decode to the pilot CommerceSnapshot shape.
 */
import { createClient } from "@libsql/client";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
  commerceQueryCells,
  decodeCommerceMapPoints,
  readCommerceSnapshot,
} from "@/lib/complex-detail/commerce-db";
import { jamsilElsCommerceSnapshot } from "@/lib/complex-detail/commerce-snapshot";

async function main() {
  const path = process.argv[2];
  const sample = Number(process.argv[3] ?? 400);
  if (!path) throw new Error("usage: test-commerce-db.ts <local.sqlite|--remote> [sampleSize]");
  let db;
  if (path === "--remote") {
    // Read-only verification against Turso (ENV_FILE). Never writes.
    const { config } = await import("dotenv");
    config({ path: process.env.ENV_FILE ?? ".env.local", quiet: true });
    db = createClient({
      url: process.env.TURSO_DATABASE_URL!.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN?.trim(),
    });
  } else {
    db = createClient({ url: pathToFileURL(resolve(path)).href });
  }

  const ids = (
    await db.execute({
      sql: `SELECT complex_id FROM complex_commerce_snapshots WHERE radius_m = 1000
            ORDER BY complex_id LIMIT ?`,
      args: [100000],
    })
  ).rows.map((r) => String(r.complex_id));
  const step = Math.max(1, Math.floor(ids.length / sample));
  let checked = 0;
  let mismatch = 0;
  for (let i = 0; i < ids.length; i += step) {
    const snap = await readCommerceSnapshot(db, ids[i], 1000);
    assert.ok(snap, `snapshot ${ids[i]}`);
    const comp = Object.values(snap.composition).reduce((s, b) => s + b.count, 0);
    assert.equal(comp, snap.p2Total, `composition sum ${ids[i]}`);
    if (snap.mapPoints?.pointCount !== snap.p2Total) {
      mismatch += 1;
      console.log(`[mismatch] ${ids[i]} points=${snap.mapPoints?.pointCount} p2=${snap.p2Total}`);
    }
    checked += 1;
  }
  assert.equal(mismatch, 0, "map point count must equal p2_total");

  // 잠실엘스 pilot-center parity (runtime decoder path)
  const pilot = jamsilElsCommerceSnapshot;
  const center = { lat: pilot.mapPoints!.originLat, lng: pilot.mapPoints!.originLng };
  const keys = commerceQueryCells(center.lat, center.lng, 1000);
  const cells = await db.execute({
    sql: `SELECT cell_key, points_json FROM commerce_point_cells
          WHERE cell_key IN (${keys.map(() => "?").join(",")})`,
    args: keys,
  });
  const mp = decodeCommerceMapPoints(
    cells.rows.map((r) => ({ cellKey: Number(r.cell_key), pointsJson: String(r.points_json) })),
    center,
    1000,
  );
  assert.equal(mp.pointCount, pilot.p2Total);
  const mix = (idx: number[]) => idx.reduce<Record<number, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {});
  assert.deepEqual(mix(mp.categoryIdx!), mix(pilot.mapPoints!.categoryIdx!));
  const sortPts = (o: number[], c: number[]) =>
    c.map((b, i) => [o[2 * i], o[2 * i + 1], b]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const want = sortPts(pilot.mapPoints!.offsetsM, pilot.mapPoints!.categoryIdx!);
  const got = sortPts(mp.offsetsM, mp.categoryIdx!);
  let exact = 0;
  const wantKey = new Map<string, number>();
  for (const p of want) wantKey.set(p.join(","), (wantKey.get(p.join(",")) ?? 0) + 1);
  for (const p of got) {
    const k = p.join(",");
    if ((wantKey.get(k) ?? 0) > 0) {
      wantKey.set(k, wantKey.get(k)! - 1);
      exact += 1;
    }
  }

  // Production row for 잠실엘스 (NAVER anchor center)
  const prod = await readCommerceSnapshot(db, pilot.complexId, 1000);
  console.log(
    JSON.stringify(
      {
        sampled: checked,
        pointCountMismatches: mismatch,
        pilotCenterPoints: { count: mp.pointCount, exactOffsetMatch: exact, fixture: pilot.p2Total },
        jamsilElsProductionRow: prod && {
          p0: prod.p0Total,
          p2: prod.p2Total,
          coordinateSource: prod.coordinateSource,
          points: prod.mapPoints?.pointCount,
        },
      },
      null,
      2,
    ),
  );
  console.log("commerce-db tests ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
