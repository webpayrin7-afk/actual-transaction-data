/**
 * High-school openData apiType52 (13-다) career field map.
 *
 * Official 정보공시 leaves (졸업자 + 5):
 *   전문대학, 대학교, 국외진학, 취업자, 기타
 *
 * openData exposes TOTAL2 + TOTAL3..TOTAL8 (6 partition fields).
 * Resolution of 5 vs 6:
 *   OUT_TOT_SUM === TOTAL5+TOTAL6 always (국외진학 subtypes rolled up)
 *   TOT_SUM === TOTAL3+TOTAL4+TOTAL5+TOTAL6 always (진학자 = 국내+국외)
 *   Product shows one 국외진학 leaf = TOTAL5+TOTAL6 (not separate TOTAL5/TOTAL6 labels).
 *
 * Do NOT reuse middle-school TOTAL3–14 bindings.
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
  /** Raw TOTAL fields summed into this leaf (UI never sees field names). */
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

/** Individual TOTAL5/TOTAL6 subtype labels — not product-visible (rolled into 국외진학). */
export const HIGH_OVERSEAS_SUBTYPE_NOTE =
  "TOTAL5+TOTAL6 roll up to official leaf 국외진학 (OUT_TOT_SUM). Subtype split (국외전문 vs 국외대학) is not product-exposed without CONFIRMED header.";

export function visibleHighCareerBindings(): HighCareerCategoryBinding[] {
  return HIGH_CAREER_CATEGORY_BINDINGS.filter(
    (b) => b.productVisible && b.confidence !== "UNCONFIRMED",
  );
}
