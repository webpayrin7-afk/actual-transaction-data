/**
 * High-school openData apiType52 (13-다) career field map.
 * Copied from the verified school-info adapter.
 *
 * Do NOT reuse middle-school TOTAL3–14 bindings.
 * 국외진학 = TOTAL5+TOTAL6 (official single leaf). Both fields must be present.
 */

export type MappingConfidence =
  | "CONFIRMED"
  | "STRUCTURALLY_CONFIRMED"
  | "UNCONFIRMED";

export type HighCareerCategoryKey =
  | "junior_college"
  | "university"
  | "overseas"
  | "employed"
  | "other";

export type HighCareerCategoryBinding = {
  key: HighCareerCategoryKey;
  label: string;
  fields: readonly ("TOTAL3" | "TOTAL4" | "TOTAL5" | "TOTAL6" | "TOTAL7" | "TOTAL8")[];
  confidence: MappingConfidence;
  productVisible: boolean;
};

export const HIGH_GRADUATES_BINDING = {
  field: "TOTAL2" as const,
  key: "graduates" as const,
  label: "졸업자",
  confidence: "STRUCTURALLY_CONFIRMED" as MappingConfidence,
};

export const HIGH_CAREER_CATEGORY_BINDINGS: readonly HighCareerCategoryBinding[] =
  [
    {
      key: "junior_college",
      label: "전문대학",
      fields: ["TOTAL3"],
      confidence: "STRUCTURALLY_CONFIRMED",
      productVisible: true,
    },
    {
      key: "university",
      label: "대학교",
      fields: ["TOTAL4"],
      confidence: "STRUCTURALLY_CONFIRMED",
      productVisible: true,
    },
    {
      key: "overseas",
      label: "국외진학",
      fields: ["TOTAL5", "TOTAL6"],
      confidence: "STRUCTURALLY_CONFIRMED",
      productVisible: true,
    },
    {
      key: "employed",
      label: "취업자",
      fields: ["TOTAL7"],
      confidence: "STRUCTURALLY_CONFIRMED",
      productVisible: true,
    },
    {
      key: "other",
      label: "기타",
      fields: ["TOTAL8"],
      confidence: "STRUCTURALLY_CONFIRMED",
      productVisible: true,
    },
  ] as const;

export function visibleHighCareerBindings(): HighCareerCategoryBinding[] {
  return HIGH_CAREER_CATEGORY_BINDINGS.filter(
    (b) => b.productVisible && b.confidence !== "UNCONFIRMED",
  );
}
