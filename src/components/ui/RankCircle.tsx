/**
 * 순위 표시 — 순위가 들어가는 목록 공통 (1위 금 · 2위 은 · 3위 동, 4위부터 회색).
 * 목록 행 맨 앞 칸에 가운데 정렬로 둔다 (LabListRow `rank`).
 */
export function RankCircle({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "bg-amber-400 text-white"
      : rank === 2
        ? "bg-slate-400 text-white"
        : rank === 3
          ? "bg-orange-400 text-white"
          : "bg-slate-100 text-slate-600";
  return (
    <span
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${tone}`}
    >
      {rank}
    </span>
  );
}
