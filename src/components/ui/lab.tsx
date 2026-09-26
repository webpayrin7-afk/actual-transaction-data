import type { HTMLAttributes, ReactNode } from "react";
import { LabDataLoading } from "@/components/ui/LabLoading";

/**
 * Tab hierarchy (ZIPLAB UI Policy v2 §11):
 * - LabTabs variant="primary" — 48px soft-teal segmented (주요 모드)
 * - LabTabs variant="secondary" — 40px soft-teal segmented (분류·보기)
 * - LabTabs variant="compact" — 30px visual / 44px touch (기간·조건)
 * White bordered shell + soft teal selected face; hierarchy is size only.
 * Pair content tabs with `role="tabpanel"` via idPrefix.
 * Legacy class helpers below remain for non-migrated surfaces.
 *
 * Color rules:
 * - Solid teal (`.lab-button-primary`) = execution CTA only
 * - Soft teal-50 face + teal-700 text = selection (tabs/filters)
 * - White shell + muted text = unselected
 * - No gray selected state, no gradients
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
    return (
      <LabDataLoading label={typeof children === "string" ? children.replace(/…$/, "") : "불러오는 중"} minHeight={112} />
    );
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

/** Apt-detail style filter chips — shared height/padding/radius/font via `.lab-tab-secondary` */
export function labSecondaryTabClass(active: boolean, extra = "") {
  return `${LAB_TAB_SECONDARY} ${active ? LAB_TAB_SECONDARY_ACTIVE : ""} ${extra}`.trim();
}

/** Shared row for period / deal-type / nearby-life segmented controls */
export const LAB_SEGMENTED = "lab-segmented";
export function labSegmentedClass(extra = "") {
  return `${LAB_SEGMENTED} ${extra}`.trim();
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
