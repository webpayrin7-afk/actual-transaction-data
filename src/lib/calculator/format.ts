/** Display helpers for calculator amounts (만원 단위 입력). */

export function formatManWon(man: number): string {
  if (!Number.isFinite(man)) return "—";
  const rounded = Math.round(man);
  return `${rounded.toLocaleString("ko-KR")}만원`;
}

/** Input field value in 만원 (no unit suffix). 341000 → "341,000" */
export function formatManInput(man: number): string {
  if (!Number.isFinite(man) || man <= 0) return "";
  return Math.round(man).toLocaleString("ko-KR");
}

/** 340000 → 34억, 341000 → 34억 1,000만원 */
export function formatEokMan(man: number): string {
  if (!Number.isFinite(man) || man <= 0) return "—";
  const eok = Math.floor(man / 10_000);
  const rest = Math.round(man % 10_000);
  if (eok <= 0) return `${rest.toLocaleString("ko-KR")}만원`;
  if (rest === 0) return `${eok.toLocaleString("ko-KR")}억`;
  return `${eok.toLocaleString("ko-KR")}억 ${rest.toLocaleString("ko-KR")}만원`;
}

/**
 * Parse practical Korean money strings into 만원.
 * Bare numbers are 만원 (354000 → 354,000만원 = 35억 4,000만원).
 * Still accepts: 34.1억 | 34억1000 | 34억1000만 | 341000만원
 */
export function parseEokInputToMan(text: string): number | null {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, "").trim();
  if (!cleaned) return null;

  // Bare number = 만원 unit (not 억)
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const man = Number(cleaned);
    if (!Number.isFinite(man) || man < 0) return null;
    return Math.round(man);
  }

  // 34.1억 | 34억1000 | 34억1000만 | 34억1,000만원 (spaces/commas already stripped)
  const eokMatch = cleaned.match(
    /^(\d+(?:\.\d+)?)억(?:(\d+)(?:만(?:원)?)?)?$/,
  );
  if (eokMatch) {
    const eok = Number(eokMatch[1]);
    const man = eokMatch[2] ? Number(eokMatch[2]) : 0;
    if (!Number.isFinite(eok) || eok < 0 || !Number.isFinite(man) || man < 0) {
      return null;
    }
    return Math.round(eok * 10_000 + man);
  }

  const manMatch = cleaned.match(/^(\d+(?:\.\d+)?)만(?:원)?$/);
  if (manMatch) {
    const man = Number(manMatch[1]);
    if (!Number.isFinite(man) || man < 0) return null;
    return Math.round(man);
  }

  return null;
}
