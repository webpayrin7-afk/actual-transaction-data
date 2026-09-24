/**
 * Official warehouse full-history floors for MOLIT AptTrade / AptRent.
 *
 * Evidence (repo contracts — not guessed):
 * - Sale: scripts/sync-molit.ts default --trade-months=120;
 *         scripts/repair-warehouse-gaps.ts tradeYms from 201610
 * - Rent: scripts/sync-molit.ts default --rent-months=48;
 *         scripts/repair-warehouse-gaps.ts rentYms from 202210
 *
 * Live API may serve earlier trade months (phase53 probes 200601 for Hangang),
 * but warehouse sync floor for national full-history is 201610 / 202210.
 */
import { seoulToday, yearMonthFromSeoulDate } from "@/lib/market/time";

/** MOLIT AptTrade warehouse earliest supported month (YYYYMM). */
export const APTTRADE_FULL_HISTORY_EARLIEST_YM = "201610";

/** MOLIT AptRent warehouse earliest supported month (YYYYMM). */
export const APTRENT_FULL_HISTORY_EARLIEST_YM = "202210";

/** Frozen baseline already complete — do not rescan for registration. */
export const APTTRADE_REGISTRATION_BASELINE_FROM_YM = "202301";

export function currentContractYearMonth(asOf: Date = new Date()): string {
  return yearMonthFromSeoulDate(seoulToday(asOf));
}

export function yearMonthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4));
  let m = Number(fromYm.slice(4, 6));
  const ty = Number(toYm.slice(0, 4));
  const tm = Number(toYm.slice(4, 6));
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(ty) ||
    !Number.isFinite(tm)
  ) {
    return out;
  }
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 360) break;
  }
  return out;
}

export function saleFullHistoryMonths(asOf: Date = new Date()): string[] {
  return yearMonthsBetween(
    APTTRADE_FULL_HISTORY_EARLIEST_YM,
    currentContractYearMonth(asOf),
  );
}

export function rentFullHistoryMonths(asOf: Date = new Date()): string[] {
  return yearMonthsBetween(
    APTRENT_FULL_HISTORY_EARLIEST_YM,
    currentContractYearMonth(asOf),
  );
}

/** Pre-2023 sale months only (2023+ AptTrade/registration is frozen baseline). */
export function salePre2023Months(asOf: Date = new Date()): string[] {
  const cur = currentContractYearMonth(asOf);
  const end =
    APTTRADE_REGISTRATION_BASELINE_FROM_YM > cur
      ? cur
      : (() => {
          // month before 202301
          return "202212";
        })();
  if (APTTRADE_FULL_HISTORY_EARLIEST_YM > end) return [];
  return yearMonthsBetween(APTTRADE_FULL_HISTORY_EARLIEST_YM, end);
}
