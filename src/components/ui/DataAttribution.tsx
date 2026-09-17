/**
 * Compact product attribution metadata (label-only).
 * No provider endpoints, apiTypes, or raw source metadata.
 */

export function DataAttribution({
  provider,
  organization,
  context,
  providerHref,
  className = "",
}: {
  /** User-facing provider name, e.g. "학교알리미" */
  provider: string;
  /** Optional org line partner, e.g. "교육부" */
  organization?: string;
  /** Optional secondary context (not a page-wide fixed year) */
  context?: string;
  /** Official provider home/about URL when known — not a school-specific deep link */
  providerHref?: string | null;
  className?: string;
}) {
  const providerNode = providerHref ? (
    <a
      href={providerHref}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-slate-700 underline-offset-2 hover:underline"
    >
      {provider}
    </a>
  ) : (
    <span className="font-medium text-slate-700">{provider}</span>
  );

  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-4 sm:text-[12px] sm:leading-5 ${className}`.trim()}
    >
      <span className="shrink-0 font-semibold text-slate-600">자료 출처</span>
      <span className="min-w-0 text-slate-700">
        {providerNode}
        {organization ? (
          <>
            <span aria-hidden> · </span>
            <span>{organization}</span>
          </>
        ) : null}
      </span>
      {context ? (
        <>
          <span className="hidden text-slate-300 sm:inline" aria-hidden>
            |
          </span>
          <span className="basis-full text-slate-500 sm:basis-auto">
            {context}
          </span>
        </>
      ) : null}
    </div>
  );
}
