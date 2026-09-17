/**
 * Formal product attribution metadata block (label-only).
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
  const providerLine = organization
    ? `${provider} · ${organization}`
    : provider;

  const providerNode = providerHref ? (
    <a
      href={providerHref}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-2 hover:underline"
    >
      {provider}
    </a>
  ) : (
    provider
  );

  return (
    <div className={`space-y-1 ${className}`.trim()}>
      <p className="text-[12px] font-medium leading-4 tracking-tight text-slate-600">
        자료 출처
      </p>
      <p className="text-[12px] leading-4 text-slate-700">
        {organization ? (
          <>
            {providerNode}
            <span aria-hidden> · </span>
            <span>{organization}</span>
          </>
        ) : (
          providerNode
        )}
      </p>
      {context ? (
        <p className="text-[11px] leading-4 text-slate-500">{context}</p>
      ) : null}
      {/* Keep a visually-hidden full string for simple a11y/search if needed */}
      <span className="sr-only">
        자료 출처: {providerLine}
        {context ? ` · ${context}` : ""}
      </span>
    </div>
  );
}
