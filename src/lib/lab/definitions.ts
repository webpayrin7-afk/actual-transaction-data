/**
 * 실험 정의 — 향후 /lab, /lab/[slug]로 옮길 때 이 모듈을 재사용.
 * 메인은 slug로 결과를 매칭만 한다.
 */

export type LabExperimentId =
  | "volume-thermometer"
  | "area-84"
  | "price-bands"
  | "floor-mix"
  | "building-age";

export interface LabExperimentDef {
  id: LabExperimentId;
  /** URL slug 후보 (/lab/[slug]) */
  slug: LabExperimentId;
  labNo: string;
  title: string;
  question: string;
  /** A=기존 aggregate, B=bounded indexed query, C=full scan(제외) */
  computeClass: "A" | "B";
}

export const LAB_EXPERIMENTS: LabExperimentDef[] = [
  {
    id: "volume-thermometer",
    slug: "volume-thermometer",
    labNo: "LAB 01",
    title: "거래량 온도계",
    question: "최근 거래가 가장 빠르게 늘어난 곳은 어디일까?",
    computeClass: "A",
  },
  {
    id: "area-84",
    slug: "area-84",
    labNo: "LAB 02",
    title: "국민평형 84㎡",
    question: "국민평형은 어디에서 가장 많이 거래될까?",
    computeClass: "B",
  },
  {
    id: "price-bands",
    slug: "price-bands",
    labNo: "LAB 03",
    title: "요즘 많이 거래되는 가격대",
    question: "요즘 실제 거래는 어느 가격대에 가장 많이 몰려 있을까?",
    computeClass: "B",
  },
  {
    id: "floor-mix",
    slug: "floor-mix",
    labNo: "LAB 04",
    title: "실제 거래가 많은 층",
    question: "아파트는 실제로 몇 층에서 가장 많이 거래될까?",
    computeClass: "B",
  },
  {
    id: "building-age",
    slug: "building-age",
    labNo: "LAB 05",
    title: "요즘 거래되는 아파트의 연식",
    question: "요즘 거래되는 아파트는 몇 년 차일까?",
    computeClass: "B",
  },
];

export const LAB_FEATURED_ID: LabExperimentId = "volume-thermometer";

export function getLabDef(id: LabExperimentId): LabExperimentDef {
  const found = LAB_EXPERIMENTS.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown lab experiment: ${id}`);
  return found;
}
