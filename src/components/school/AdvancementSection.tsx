import type { AdvancementData } from "@/lib/school-info/types";
import { canRenderAdvancementSection } from "@/lib/school-info/advancement-disclosure";

/**
 * Future middle-school 진학현황 section.
 *
 * Insertion: immediately after 학교 현황, before 학교생활.
 * Renders only when ADVANCEMENT_API52 is PASS and normalized data exists.
 * Never invents TOTAL* labels or placeholder/"준비중" UI.
 */
export function AdvancementSection({
  data,
  schoolKind,
}: {
  data: AdvancementData | null | undefined;
  /** SchoolInfo kind label (e.g. 중학교). Middle schools only. */
  schoolKind: string | null | undefined;
}) {
  if (!canRenderAdvancementSection()) return null;
  if (!schoolKind?.includes("중")) return null;
  if (!data) return null;

  const hasBody =
    Boolean(data.graduates?.value) || data.categories.length > 0;
  if (!hasBody) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white px-3.5 py-3.5 sm:px-4 sm:py-4">
      <h2 className="text-[13px] font-semibold tracking-tight text-slate-800">
        진학 현황
      </h2>
      {data.graduates?.value ? (
        <p className="mt-2 text-[13px] font-semibold tabular-nums text-slate-900">
          졸업생 {data.graduates.value}
        </p>
      ) : null}
      {data.categories.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {data.categories.map((c) => (
            <li
              key={c.label}
              className="flex items-baseline justify-between gap-3 text-[13px]"
            >
              <span className="text-slate-600">{c.label}</span>
              <span className="font-semibold tabular-nums text-slate-900">
                {c.count != null ? `${c.count.toLocaleString("ko-KR")}명` : ""}
                {c.count != null && c.percent != null ? " · " : ""}
                {c.percent != null ? `${c.percent}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
