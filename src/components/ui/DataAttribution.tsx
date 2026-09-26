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
      className="relative inline-block text-slate-600 underline-offset-2 before:absolute before:inset-x-0 before:-inset-y-3 before:content-[''] hover:underline"
    >
      {provider}
    </a>
  ) : (
    <span>{provider}</span>
  );

  return (
    <p
      className={`detail-meta ${className}`.trim()}
    >
      <span className="font-semibold text-slate-600">자료 출처</span>
      <span className="mx-1.5">
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
          <span className="text-slate-300" aria-hidden>
            |
          </span>
          <span className="ml-1.5">{context}</span>
        </>
      ) : null}
    </p>
  );
}
