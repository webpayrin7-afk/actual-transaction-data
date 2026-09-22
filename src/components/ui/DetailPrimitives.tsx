import type { ReactNode } from "react";

/**
 * ZIPLAB UI Policy v2 role primitives for complex detail.
 * Prefer these over one-off font-size utilities.
 */

export function DetailSection({
  id,
  title,
  meta,
  children,
  className = "",
}: {
  id?: string;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`lab-card detail-card scroll-mt-28 ${className}`.trim()}
    >
      <div>
        <h2 className="detail-section-title">{title}</h2>
        {meta ? <div className="detail-source mt-1">{meta}</div> : null}
      </div>
      <div className="detail-after-title">{children}</div>
    </section>
  );
}

export function DetailSubsection({
  title,
  children,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`detail-subsection ${className}`.trim()}>
      <h3 className="detail-subsection-title">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function DetailDataRow({
  label,
  value,
  emphasize = false,
}: {
  label: ReactNode;
  value: ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <p className="detail-label min-w-0">{label}</p>
      <div
        className={`shrink-0 text-right ${
          emphasize ? "detail-data-value-emphasis" : "detail-data-value"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function DetailSourceNote({ children }: { children: ReactNode }) {
  return <p className="detail-source">{children}</p>;
}

export function DetailAsyncState({
  kind,
  children,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  children: ReactNode;
  onRetry?: () => void;
}) {
  if (kind === "loading") {
    return (
      <div className="lab-skeleton" aria-busy="true" aria-label="불러오는 중">
        <span className="sr-only">{children}</span>
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="lab-state lab-state-error" role="alert">
        <div>
          <p>{children}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="lab-button lab-button-secondary mt-3"
            >
              다시 시도
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return <div className="lab-state">{children}</div>;
}
