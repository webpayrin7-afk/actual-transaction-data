import type { AdvancementData } from "@/lib/school-info/types";
import { canRenderAdvancementSection } from "@/lib/school-info/advancement-disclosure";

/**
 * Middle-school 진학현황 (apiType52 → AdvancementData).
 * Insertion: after 학교 현황, before 학교생활.
 * High schools use a different career schema — not rendered here while HOLD.
 */
export function AdvancementSection({
  data,
  schoolKind,
}: {
  data: AdvancementData | null | undefined;
  schoolKind: string | null | undefined;
}) {
  if (!canRenderAdvancementSection()) return null;
  if (!schoolKind?.includes("중")) return null;
  if (!data) return null;

  const categories = data.categories.filter(
    (c) => c.count != null && c.count > 0,
  );

  const hasBody =
    Boolean(data.graduates?.value) || categories.length > 0;
  if (!hasBody) return null;

  const yearLabel = data.year ? `${data.year}년 공시` : null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-slate-800">
          진학 현황
        </h2>
        {yearLabel ? (
          <p className="text-[11px] text-slate-500">{yearLabel}</p>
        ) : null}
      </div>
      {data.graduates?.value ? (
        <p className="mt-2 text-[13px] font-semibold tabular-nums text-slate-900">
          졸업생 {data.graduates.value}
        </p>
      ) : null}
      {categories.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5">
          {categories.map((c) => (
            <li
              key={c.key}
              className="flex items-baseline justify-between gap-3 text-[13px]"
            >
              <span className="min-w-0 text-slate-600">{c.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                {c.count != null ? `${c.count.toLocaleString("ko-KR")}명` : ""}
                {c.count != null && c.percent != null ? " · " : ""}
                {c.percent != null ? `${c.percent}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.completeness === "partial" ? (
        <p className="mt-2 text-[11px] leading-4 text-slate-500">
          일부 분류만 표시합니다. 표시 항목 합계가 졸업생 전체와 다를 수
          있습니다.
        </p>
      ) : null}
    </section>
  );
}
