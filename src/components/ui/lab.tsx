import type { HTMLAttributes, ReactNode } from "react";

export function LabCard({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`lab-card ${className}`.trim()} {...props} />;
}

export function LabSectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="lab-section-heading">
      <div className="min-w-0">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function LabState({ tone = "empty", children }: { tone?: "loading" | "empty" | "error"; children?: ReactNode }) {
  if (tone === "loading") return <div className="lab-skeleton" aria-label="불러오는 중" />;
  return <div className={`lab-state lab-state-${tone}`}>{children}</div>;
}

export const LAB_BUTTON_PRIMARY = "lab-button lab-button-primary";
export const LAB_BUTTON_SECONDARY = "lab-button lab-button-secondary";
export const LAB_INPUT = "lab-input";
export const LAB_TAB = "lab-tab";
export const LAB_BADGE = "lab-badge";
