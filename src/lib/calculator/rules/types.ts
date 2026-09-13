/** Versioned policy rule metadata for calculator modules. */

export type RuleMeta = {
  /** Stable id for this rule pack */
  ruleVersion: string;
  /** Inclusive effective date (YYYY-MM-DD, KST policy date) */
  effectiveFrom: string;
  /** Human-readable official / secondary source note */
  source: string;
  /** Short Korean title */
  title: string;
};

export type MoneyMan = number; // 만원
export type MoneyWon = number; // 원
