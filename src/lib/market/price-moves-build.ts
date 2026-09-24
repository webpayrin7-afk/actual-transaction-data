/**
 * 신고가 · 하락 거래 기록 만들기 — 하루(집랩이 처음 확인한 날, KST) 단위.
 * 판정 규칙은 시장 홈(computeMarketHome)과 같다. 여기서는 목록을 자르지 않고 전부 남기고,
 * 이전 최고가가 언제였는지(prior_max_date)도 함께 기록한다.
 * 읽기 전용 계산 — 쓰기는 scripts/build-price-moves.ts 가 dry-run 뒤 --apply 로만 한다.
 */
import type { Client } from "@libsql/client";
import { hasDiscoveryAtColumn } from "@/lib/db/discovery-axis";
import { DROP_THRESHOLD, typeKey } from "@/lib/market/keys";
import { seoulDayBoundsUtc } from "@/lib/market/time";

export const PRICE_MOVES_RULE_VERSION = "price_moves_v1";

export type PriceMoveKind = "singoga" | "drop";

export type PriceMoveRow = {
  txId: string;
  kind: PriceMoveKind;
  seenDate: string;
  dealDate: string;
  lawdCd: string;
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  floor: number | null;
  dealAmount: number;
  priorMaxAmount: number;
  priorMaxDate: string | null;
  changeAmount: number;
  changePct: number;
};

export type PriceMovesDay = {
  seenDate: string;
  /** 그날 처음 확인된 매매 수 */
  seenTrades: number;
  rows: PriceMoveRow[];
};

type Seen = {
  id: string;
  lawdCd: string;
  dealDate: string;
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  floor: number | null;
  dealAmount: number;
};

const NORM_CHUNK = 80;
const LAWD_CONCURRENCY = 6;

export async function computePriceMovesForDay(db: Client, seenDate: string): Promise<PriceMovesDay> {
  const activityCol = (await hasDiscoveryAtColumn(db)) ? "discovery_at" : "first_seen_at";
  const { startIso, endIso } = seoulDayBoundsUtc(seenDate);
  const res = await db.execute({
    sql: `SELECT id, lawd_cd, deal_date, apt_name, apt_name_norm, gu, dong,
                 exclusive_area, floor, deal_amount
          FROM transactions
          WHERE deal_type = 'trade'
            AND ${activityCol} IS NOT NULL AND ${activityCol} != ''
            AND ${activityCol} >= ? AND ${activityCol} < ?`,
    args: [startIso, endIso],
  });
  const seen: Seen[] = res.rows.map((r) => {
    const fl = Number(r.floor);
    return {
      id: String(r.id),
      lawdCd: String(r.lawd_cd),
      dealDate: String(r.deal_date).slice(0, 10),
      aptName: String(r.apt_name),
      aptNameNorm: String(r.apt_name_norm),
      gu: String(r.gu ?? ""),
      dong: String(r.dong ?? ""),
      exclusiveArea: Number(r.exclusive_area) || 0,
      floor: Number.isFinite(fl) ? fl : null,
      dealAmount: Number(r.deal_amount) || 0,
    };
  });
  if (seen.length === 0) return { seenDate, seenTrades: 0, rows: [] };

  // 거래마다 "계약일 이전"의 같은 단지·동·면적 최고가와 그 계약일.
  // (시군구, 단지명)별 매매 이력을 한 번만 읽고(idx_tx_lawd_apt_ym), 계약일 비교는 메모리에서 한다.
  // 단지명만으로 찾으면 흔한 이름(현대·삼성…)의 전국 거래를 모두 읽어 하루치에 수 분이 걸린다.
  // 인덱스는 강제한다 — 힌트 없이는 플래너가 시군구 전체를 훑어 100초, 힌트로 3~4초 (2026-09-25 측정).
  const byLawd = new Map<string, Set<string>>();
  for (const tx of seen) {
    const set = byLawd.get(tx.lawdCd) ?? new Set<string>();
    set.add(tx.aptNameNorm);
    byLawd.set(tx.lawdCd, set);
  }
  type Hist = { amount: number; date: string };
  const history = new Map<string, Hist[]>();
  const jobs: Array<() => Promise<void>> = [];
  for (const [lawd, normSet] of byLawd) {
    const norms = [...normSet];
    for (let n = 0; n < norms.length; n += NORM_CHUNK) {
      const slice = norms.slice(n, n + NORM_CHUNK);
      jobs.push(async () => {
        const hist = await db.execute({
          sql: `SELECT apt_name_norm, dong, exclusive_area, deal_amount, deal_date
                FROM transactions INDEXED BY idx_tx_lawd_apt_ym
                WHERE lawd_cd = ? AND apt_name_norm IN (${slice.map(() => "?").join(",")})
                  AND deal_type = 'trade'`,
          args: [lawd, ...slice],
        });
        for (const row of hist.rows) {
          const amount = Number(row.deal_amount) || 0;
          if (amount <= 0) continue;
          const key = typeKey(String(row.apt_name_norm), lawd, String(row.dong ?? ""), Number(row.exclusive_area) || 0);
          const list = history.get(key) ?? [];
          list.push({ amount, date: String(row.deal_date).slice(0, 10) });
          history.set(key, list);
        }
      });
    }
  }
  for (let i = 0; i < jobs.length; i += LAWD_CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + LAWD_CONCURRENCY).map((j) => j()));
  }

  const prior = new Map<string, { amount: number; date: string | null }>();
  for (const tx of seen) {
    const list = history.get(typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea));
    if (!list) continue;
    let best: Hist | null = null;
    for (const h of list) {
      if (h.date < tx.dealDate && (!best || h.amount > best.amount)) best = h;
    }
    if (best) prior.set(tx.id, { amount: best.amount, date: best.date });
  }

  const rows: PriceMoveRow[] = [];
  for (const tx of seen) {
    const p = prior.get(tx.id);
    if (!p || p.amount <= 0 || tx.dealAmount <= 0) continue;
    const change = tx.dealAmount - p.amount;
    const pct = change / p.amount;
    const kind: PriceMoveKind | null = change > 0 ? "singoga" : pct <= DROP_THRESHOLD ? "drop" : null;
    if (!kind) continue;
    rows.push({
      txId: tx.id,
      kind,
      seenDate,
      dealDate: tx.dealDate,
      lawdCd: tx.lawdCd,
      aptName: tx.aptName,
      aptNameNorm: tx.aptNameNorm,
      gu: tx.gu,
      dong: tx.dong,
      exclusiveArea: tx.exclusiveArea,
      floor: tx.floor,
      dealAmount: tx.dealAmount,
      priorMaxAmount: p.amount,
      priorMaxDate: p.date,
      changeAmount: change,
      changePct: Math.round(pct * 1000) / 10,
    });
  }
  return { seenDate, seenTrades: seen.length, rows };
}
