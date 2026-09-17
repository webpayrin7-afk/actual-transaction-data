import type { AdvancementData } from "@/lib/school-info/types";
import { canRenderAdvancementSection } from "@/lib/school-info/advancement-disclosure";
import { advancementColorByRank } from "@/lib/school-info/advancement-category-colors";

type VisibleCategory = {
  key: string;
  label: string;
  count: number;
  percent: number | null;
  color: string;
};

/**
 * Presentation for middle 진학현황 / high 진학·진로현황.
 * Consumes normalized AdvancementData only — no TOTAL field / mapping logic.
 */
export function AdvancementSection({
  data,
  schoolKind,
}: {
  data: AdvancementData | null | undefined;
  schoolKind: string | null | undefined;
}) {
  const isMiddle = Boolean(schoolKind?.includes("중"));
  const isHigh = Boolean(schoolKind?.includes("고"));

  if (isMiddle && !canRenderAdvancementSection()) return null;
  if (!isMiddle && !isHigh) return null;
  if (!data) return null;

  const categories: VisibleCategory[] = data.categories
    .filter((c): c is typeof c & { count: number } => c.count != null && c.count > 0)
    .map((c) => ({
      key: c.key,
      label: c.label,
      count: c.count,
      percent: c.percent,
      color: "", // filled after sort
    }))
    .sort((a, b) => b.count - a.count)
    .map((c, i) => ({ ...c, color: advancementColorByRank(i) }));

  const hasBody =
    Boolean(data.graduates?.value) || categories.length > 0;
  if (!hasBody) return null;

  const yearLabel = data.year ? `${data.year}년 공시` : null;
  const title = isHigh ? "진학·진로 현황" : "진학 현황";
  const helper = isHigh
    ? "이 고등학교 졸업생의 진로 현황입니다."
    : "이 중학교 졸업생의 고등학교 진학 현황입니다.";

  const donutStops = buildConicStops(categories);

  return (
    <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-slate-800">
          {title}
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

      <p className="mt-1 text-[11px] leading-4 text-slate-500">{helper}</p>

      {categories.length > 0 ? (
        <div className="mt-3.5 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:gap-5">
          {donutStops ? (
            <div className="mx-auto w-full max-w-[168px] shrink-0 sm:mx-0 sm:w-[168px]">
              <AdvancementDonut
                stops={donutStops}
                centerValue={data.graduates?.value ?? null}
                ariaSummary={categories
                  .map(
                    (c) =>
                      `${c.label} ${c.count.toLocaleString("ko-KR")}명${
                        c.percent != null ? ` ${c.percent}%` : ""
                      }`,
                  )
                  .join(", ")}
              />
            </div>
          ) : null}

          <ul className="min-w-0 flex-1 space-y-2.5">
            {categories.map((c) => (
              <li key={c.key} className="min-w-0">
                <div className="flex items-start gap-2 text-[13px]">
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: c.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 break-words leading-5 text-slate-600">
                    {c.label}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2.5 pt-px tabular-nums">
                    <span className="min-w-[3.25rem] text-right font-semibold text-slate-900">
                      {`${c.count.toLocaleString("ko-KR")}명`}
                    </span>
                    <span className="min-w-[3.25rem] text-right font-semibold text-slate-800">
                      {c.percent != null ? `${c.percent}%` : ""}
                    </span>
                  </span>
                </div>
                {c.percent != null ? (
                  <div
                    className="ml-4 mt-1 h-1 overflow-hidden rounded-full bg-slate-100"
                    aria-hidden
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, c.percent))}%`,
                        backgroundColor: c.color,
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-[10px] leading-4 text-slate-400">
        비율은 졸업생 수 기준입니다. 0명인 항목은 표시하지 않습니다.
      </p>

      {data.completeness === "partial" ? (
        <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
          일부 분류만 표시합니다. 표시 항목 합계가 졸업생 전체와 다를 수
          있습니다.
        </p>
      ) : null}
    </section>
  );
}

function buildConicStops(categories: VisibleCategory[]): string | null {
  const withPct = categories.filter(
    (c): c is VisibleCategory & { percent: number } =>
      c.percent != null && c.percent > 0,
  );
  if (withPct.length === 0) return null;

  let cursor = 0;
  const parts: string[] = [];
  for (const c of withPct) {
    const next = cursor + c.percent;
    parts.push(`${c.color} ${cursor}% ${next}%`);
    cursor = next;
  }
  if (cursor < 100) {
    parts.push(`#e2e8f0 ${cursor}% 100%`);
  }
  return parts.join(", ");
}

function AdvancementDonut({
  stops,
  centerValue,
  ariaSummary,
}: {
  stops: string;
  centerValue: string | null;
  ariaSummary: string;
}) {
  return (
    <div
      className="relative mx-auto aspect-square w-full max-w-[168px]"
      role="img"
      aria-label={`진학 비율 구성: ${ariaSummary}`}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${stops})` }}
        aria-hidden
      />
      <div
        className="absolute inset-[22%] flex flex-col items-center justify-center rounded-full bg-white text-center shadow-[inset_0_0_0_1px_rgba(15,23,42,0.04)]"
        aria-hidden
      >
        <span className="text-[10px] font-medium leading-none text-slate-500">
          졸업생
        </span>
        {centerValue ? (
          <span className="mt-1 text-[15px] font-semibold tabular-nums leading-none tracking-tight text-slate-900">
            {centerValue}
          </span>
        ) : null}
      </div>
    </div>
  );
}
