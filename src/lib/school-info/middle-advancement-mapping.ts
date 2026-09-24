/**
 * Middle-school apiType52 (13-다) TOTAL* → meaning map.
 *
 * Confidence vocabulary (product order §6):
 * - CONFIRMED: official TOTAL↔header/document binding
 * - STRUCTURALLY_CONFIRMED: official 12-leaf order + 12 TOTAL fields +
 *   TOTAL=MAN+WOMAN + RATE≈count/graduates + multi-school invariants +
 *   screen anchors lock the sequence (no other rational bijection)
 * - UNCONFIRMED: single-screen / order-only guess
 *
 * Official leaf order: 2022 초·중등학교 정보공시 입력 지침서 13-다
 * (also consistent with PR #93 SOT + 정보공시 form leaves).
 *
 * Screen anchors (잠실중 2025 user-reported): TOTAL3/4/6/9/11.
 * Gaps TOTAL5/7/8/10/12–14 are uniquely determined between anchors.
 */

export type MappingConfidence =
  | "CONFIRMED"
  | "STRUCTURALLY_CONFIRMED"
  | "UNCONFIRMED";

export type MiddleAdvancementField =
  | "TOTAL2"
  | "TOTAL3"
  | "TOTAL4"
  | "TOTAL5"
  | "TOTAL6"
  | "TOTAL7"
  | "TOTAL8"
  | "TOTAL9"
  | "TOTAL10"
  | "TOTAL11"
  | "TOTAL12"
  | "TOTAL13"
  | "TOTAL14";

export type MiddleCategoryKey =
  | "general_hs"
  | "specialized_hs"
  | "science_hs"
  | "foreign_intl_hs"
  | "arts_sports_hs"
  | "meister_hs"
  | "autonomous_private_hs"
  | "autonomous_public_hs"
  | "other_advancers"
  | "employed"
  | "alternative_unrecognized"
  | "unemployed_unknown";

export type MiddleCategoryBinding = {
  field: Exclude<MiddleAdvancementField, "TOTAL2">;
  key: MiddleCategoryKey;
  /** Official 지침/hangmok label — do not substitute 자사고 for 자율형사립고. */
  label: string;
  confidence: MappingConfidence;
  productVisible: boolean;
};

export const MIDDLE_GRADUATES_BINDING = {
  field: "TOTAL2" as const,
  key: "graduates" as const,
  label: "졸업자",
  confidence: "STRUCTURALLY_CONFIRMED" as MappingConfidence,
};

/**
 * Product-visible middle advancement categories (all STRUCTURALLY_CONFIRMED).
 * Order matches official 13-다 leaf order.
 */
export const MIDDLE_CATEGORY_BINDINGS: readonly MiddleCategoryBinding[] = [
  {
    field: "TOTAL3",
    key: "general_hs",
    label: "일반고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL4",
    key: "specialized_hs",
    label: "특성화고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL5",
    key: "science_hs",
    label: "과학고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL6",
    key: "foreign_intl_hs",
    label: "외고·국제고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL7",
    key: "arts_sports_hs",
    label: "예고·체고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL8",
    key: "meister_hs",
    label: "마이스터고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL9",
    key: "autonomous_private_hs",
    label: "자율형사립고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL10",
    key: "autonomous_public_hs",
    label: "자율형공립고",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL11",
    key: "other_advancers",
    label: "기타",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL12",
    key: "employed",
    label: "취업자",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL13",
    key: "alternative_unrecognized",
    label: "대안교육기관진학(학력미인정)",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
  {
    field: "TOTAL14",
    key: "unemployed_unknown",
    label: "무직자 및 미상",
    confidence: "STRUCTURALLY_CONFIRMED",
    productVisible: true,
  },
] as const;

export function visibleMiddleBindings(): MiddleCategoryBinding[] {
  return MIDDLE_CATEGORY_BINDINGS.filter(
    (b) => b.productVisible && b.confidence !== "UNCONFIRMED",
  );
}
