/**
 * "최근 거래" 고르기 — 지도 마커·카드와 단지 상세가 같은 거래를 가리키도록 한 규칙.
 *  - 매매: 직거래는 뺀다 (직거래만 있으면 그중에서)
 *  - 전세: 갱신 계약은 뺀다 (인상 상한이 있는 재계약이라 시세가 아님 — 신규만 있으면 신규, 없으면 전체)
 *  - 계약일이 가장 늦은 거래, 같은 날이면 높은 층 → 큰 금액 순
 */
export type LatestPick<T> = {
  date: (row: T) => string;
  floor: (row: T) => number | null | undefined;
  amount: (row: T) => number;
  gbn: (row: T) => string | null | undefined;
};

export function pickLatestDeal<T>(rows: readonly T[], kind: "trade" | "jeonse", f: LatestPick<T>): T | null {
  if (!rows.length) return null;
  const excluded = (r: T) => {
    const g = String(f.gbn(r) ?? "");
    return kind === "trade" ? g === "직거래" : g === "갱신";
  };
  const pool = rows.some((r) => !excluded(r)) ? rows.filter((r) => !excluded(r)) : [...rows];
  return pool.reduce((best, r) => {
    const d = f.date(r);
    const bd = f.date(best);
    if (d !== bd) return d > bd ? r : best;
    const fl = f.floor(r) ?? -999;
    const bfl = f.floor(best) ?? -999;
    if (fl !== bfl) return fl > bfl ? r : best;
    return f.amount(r) > f.amount(best) ? r : best;
  });
}
