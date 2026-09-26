/**
 * production 읽기 전용 확인 — 스냅샷에 들어갈 내용이 라이브 쿼리와 같은지 (쓰기 0).
 *
 *   npx tsx scripts/verify-apt-tx-snapshot-prod.ts             # 고정 단지 + 무작위 12단지
 *   npx tsx scripts/verify-apt-tx-snapshot-prod.ts --sample=30
 *
 * 단지마다
 * - 라이브: queryAptTransactions (trade+rent / trade만 / rent만, 스냅샷 읽기 끔) — 시간도 잰다
 * - 빌더 읽기(fetchAptTxRowsForSnapshot, 같은 lawd 여러 단지 IN 묶음) → 인코딩 → brotli → 디코드
 * - 둘이 키·값·순서까지 같은지, dealKinds 필터 결과도 같은지
 * - payload 크기: 새 형식 vs 기존 apt_tx_snapshot(format 1, gzip)
 * 표본은 기존 apt_tx_snapshot 의 작은 컬럼(lawd_cd, apt_name_norm, length(payload))만 읽어 고른다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getDb } from "../src/lib/db/client";
import { queryAptTransactions } from "../src/lib/db/repository";
import {
  compressPacked,
  decompressPacked,
  fetchAptTxRowsForSnapshot,
  packAptTx,
  sameAptTxRows,
  unpackAptTx,
} from "../src/lib/db/apt-tx-snapshot";
import type { DealType, Transaction } from "../src/types/transaction";

process.env.APT_TX_SNAPSHOT_READ = "0";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const FIXED = [
  { lawdCd: "11710", norm: "헬리오시티" },
  { lawdCd: "11710", norm: "잠실엘스" },
  { lawdCd: "11650", norm: "래미안원베일리" },
];

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB 없음");
  const sample = Math.max(0, Number(argValue("sample", "12")) || 12);

  const picks: Array<{ lawdCd: string; norm: string; oldBytes: number | null }> = [];
  for (const f of FIXED) {
    const rs = await db.execute({
      sql: `SELECT length(payload) AS b FROM apt_tx_snapshot WHERE lawd_cd = ? AND apt_name_norm = ?`,
      args: [f.lawdCd, f.norm],
    });
    picks.push({ ...f, oldBytes: rs.rows[0] ? Number(rs.rows[0].b) : null });
  }
  const mx = Number((await db.execute(`SELECT MAX(rowid) AS m FROM apt_tx_snapshot`)).rows[0].m);
  const seenLawd = new Set<string>();
  while (picks.length < FIXED.length + sample) {
    const rid = 1 + Math.floor(Math.random() * mx);
    const rs = await db.execute({
      sql: `SELECT lawd_cd, apt_name_norm, length(payload) AS b FROM apt_tx_snapshot WHERE rowid = ?`,
      args: [rid],
    });
    const r = rs.rows[0];
    if (!r || seenLawd.has(String(r.lawd_cd))) continue; // 지역을 넓게
    seenLawd.add(String(r.lawd_cd));
    picks.push({ lawdCd: String(r.lawd_cd), norm: String(r.apt_name_norm), oldBytes: Number(r.b) });
  }

  // 빌더 읽기: lawd 별로 묶어 한 번에 (IN 여러 단지 경로도 확인)
  const byLawd = new Map<string, string[]>();
  for (const p of picks) byLawd.set(p.lawdCd, [...(byLawd.get(p.lawdCd) ?? []), p.norm]);
  const built = new Map<string, Transaction[]>();
  for (const [lawd, norms] of byLawd) {
    const m = await fetchAptTxRowsForSnapshot(db, lawd, norms);
    for (const [norm, rows] of m) built.set(`${lawd}|${norm}`, rows);
  }

  let failures = 0;
  let oldTotal = 0;
  let newTotal = 0;
  for (const p of picks) {
    const rows = built.get(`${p.lawdCd}|${p.norm}`)!;
    const json = packAptTx(rows, p.lawdCd);
    const payload = compressPacked(json);
    const t0 = performance.now();
    const decoded = unpackAptTx(decompressPacked(payload), p.lawdCd);
    const decodeMs = performance.now() - t0;
    const parts: string[] = [];
    for (const kinds of [undefined, ["trade"], ["rent"]] as Array<DealType[] | undefined>) {
      const tl = performance.now();
      const live = await queryAptTransactions({ lawdCodes: [p.lawdCd], aptName: p.norm, yearMonths: [], dealKinds: kinds });
      const liveMs = Math.round(performance.now() - tl);
      const set = new Set<string>(kinds ?? ["trade", "rent"]);
      const snap = decoded.filter((t) => set.has(t.dealType));
      const diff = sameAptTxRows(live, snap);
      if (diff) failures += 1;
      parts.push(`${kinds?.join("") ?? "all"}=${live.length}rows/${liveMs}ms${diff ? ` DIFF(${diff})` : ""}`);
    }
    if (p.oldBytes != null) {
      oldTotal += p.oldBytes;
      newTotal += payload.byteLength;
    }
    console.log(
      `${failures ? "…" : "ok"} ${p.lawdCd} ${p.norm} ${parts.join(" ")} payload new=${payload.byteLength}B old=${p.oldBytes ?? "-"}B decode=${decodeMs.toFixed(1)}ms`,
    );
  }
  console.log(
    `[verify] complexes=${picks.length} lawds=${byLawd.size} failures=${failures} payload new/old=${newTotal}/${oldTotal} (${oldTotal ? ((1 - newTotal / oldTotal) * 100).toFixed(1) : "-"}% 작음)`,
  );
  process.exit(failures ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
