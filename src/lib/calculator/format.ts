/** Display helpers for calculator amounts (만원 단위 입력). */

export function formatManWon(man: number): string {
  if (!Number.isFinite(man)) return "—";
  const rounded = Math.round(man);
  return `${rounded.toLocaleString("ko-KR")}만원`;
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

export function parseEokInputToMan(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (!cleaned) return null;
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const eok = Number(cleaned);
    if (!Number.isFinite(eok) || eok < 0) return null;
    return Math.round(eok * 10_000);
  }
  return null;
}
