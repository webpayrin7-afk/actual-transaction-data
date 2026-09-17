/**
 * Minimal required attribution — display label only.
 * No provider endpoints, apiTypes, or raw source metadata.
 */

export function DataAttribution({
  label,
  className = "",
}: {
  /** User-facing source name, e.g. "학교알리미" */
  label: string;
  className?: string;
}) {
  const text = label.startsWith("출처:") ? label : `출처: ${label}`;
  return (
    <p
      className={`text-[11px] leading-4 text-slate-500 ${className}`.trim()}
    >
      {text}
    </p>
  );
}
