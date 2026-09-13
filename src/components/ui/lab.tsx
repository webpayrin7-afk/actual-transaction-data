import type { HTMLAttributes, ReactNode } from "react";

/**
 * LAB interaction color rules (existing tokens only):
 * - Solid teal (`.lab-button-primary`) = execution CTA only
 * - Light teal bg + dark teal text = selection (tabs/filters)
 * - White/transparent + neutral border/text = unselected
 * - No gray selected state, no gradients
 *
 * Tab hierarchy (same colors; size/spacing differ):
 * - Primary (`.lab-tab` + `.lab-tab-primary`): page section switcher
 * - Secondary (`.lab-tab-secondary`): in-view data filter/range chips
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
export const LAB_TAB_PRIMARY = "lab-tab lab-tab-primary";
export const LAB_TAB_SECONDARY = "lab-tab-secondary";
export const LAB_TAB_SECONDARY_ACTIVE = "lab-tab-secondary-active";
/** Selection option/chip — light teal when selected */
export const LAB_CHOICE = "lab-choice";
export const LAB_CHOICE_SELECTED = "lab-choice-selected";
export const LAB_BADGE = "lab-badge";

export function labTabClass(active: boolean, extra = "") {
  return `${LAB_TAB} ${active ? LAB_TAB_ACTIVE : ""} ${extra}`.trim();
}

/** Region-detail style section tabs */
export function labPrimaryTabClass(active: boolean, extra = "") {
  return `${LAB_TAB_PRIMARY} ${active ? LAB_TAB_ACTIVE : ""} ${extra}`.trim();
}

/** Apt-detail style compact filter chips */
export function labSecondaryTabClass(active: boolean, extra = "") {
  return `${LAB_TAB_SECONDARY} ${active ? LAB_TAB_SECONDARY_ACTIVE : ""} ${extra}`.trim();
}

/**
 * Official LAB Series section-nav tabs: teal text + thin underline when active.
 * Transparent background — never a filled pill.
 */
export function labUnderlineTabClass(active: boolean, extra = "") {
  return `lab-tab-underline ${active ? "lab-tab-underline-active" : ""} ${extra}`.trim();
}

export function labChoiceClass(active: boolean, extra = "") {
  return `${LAB_CHOICE} ${active ? LAB_CHOICE_SELECTED : ""} ${extra}`.trim();
}
