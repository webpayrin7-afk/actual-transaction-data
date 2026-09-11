import type { HTMLAttributes, ReactNode } from "react";

/**
 * LAB interaction color rules (existing tokens only):
 * - Solid teal (`.lab-button-primary`) = execution CTA only (검색/계산/확인/저장)
 * - Light teal bg + dark teal text (`.lab-tab-active` / `.lab-choice-selected`) = selection
 * - White + neutral border (`.lab-choice` idle / secondary button) = unselected
 * - No gradients
 */
export function LabCard({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`lab-card ${className}`.trim()} {...props} />;
}

export function LabSectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
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

export function LabState({
  tone = "empty",
  children,
}: {
  tone?: "loading" | "empty" | "error";
  children?: ReactNode;
}) {
  if (tone === "loading")
    return <div className="lab-skeleton" aria-label="불러오는 중" />;
  return <div className={`lab-state lab-state-${tone}`}>{children}</div>;
}

/** Execution CTA — solid teal only */
export const LAB_BUTTON_PRIMARY = "lab-button lab-button-primary";
export const LAB_BUTTON_SECONDARY = "lab-button lab-button-secondary";
export const LAB_INPUT = "lab-input";
/** Selection tab — light teal when active */
export const LAB_TAB = "lab-tab";
export const LAB_TAB_ACTIVE = "lab-tab-active";
/** Selection option/chip — light teal when selected */
export const LAB_CHOICE = "lab-choice";
export const LAB_CHOICE_SELECTED = "lab-choice-selected";
export const LAB_BADGE = "lab-badge";
