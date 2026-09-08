import { DROP_THRESHOLD, typeKey } from "@/lib/market/keys";

/**
 * 신고가/하락 판정.
 *
 * - historical peak = 해당 계약일(deal_date) **이전** 동일 typeKey 최고가
 * - 동일 계약일 복수 건: 서로에 대해 연속 신고가를 만들지 않음
 *   (같은 날 거래는 모두 “전일까지 peak”만 기준으로 판정한 뒤,
 *    날짜가 넘어갈 때 peak를 일괄 갱신)
 */

export interface JudgeTrade {
  id: string;
  dealDate: string;
  aptNameNorm: string;
  lawdCd: string;
  dong: string;
  exclusiveArea: number;
  dealAmount: number;
}

export interface JudgeFlags {
  singoga: boolean;
  drop: boolean;
  priorMax: number;
}

/**
 * deal_date ASC 정렬된 거래를 날짜 단위로 판정.
 * runningPeak는 호출 전 워밍업(해당 구간 시작 이전 max)을 넣을 수 있다.
 */
export function judgeTradesChronological(
  trades: JudgeTrade[],
  runningPeak: Map<string, number> = new Map(),
): Map<string, JudgeFlags> {
  const out = new Map<string, JudgeFlags>();
  if (trades.length === 0) return out;

  let i = 0;
  while (i < trades.length) {
    const day = trades[i]!.dealDate.slice(0, 10);
    const dayStart = i;
    while (i < trades.length && trades[i]!.dealDate.slice(0, 10) === day) {
      i += 1;
    }
    const dayBatch = trades.slice(dayStart, i);

    // 동일일은 모두 당일 이전 peak만 사용
    for (const tx of dayBatch) {
      const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
      const prior = runningPeak.get(key) ?? 0;
      const singoga = prior > 0 && tx.dealAmount > prior;
      const drop =
        prior > 0 && (tx.dealAmount - prior) / prior <= DROP_THRESHOLD;
      out.set(tx.id, { singoga, drop, priorMax: prior });
    }

    // 날짜 종료 후 peak 갱신
    for (const tx of dayBatch) {
      const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
      const prior = runningPeak.get(key) ?? 0;
      runningPeak.set(key, Math.max(prior, tx.dealAmount));
    }
  }

  return out;
}
