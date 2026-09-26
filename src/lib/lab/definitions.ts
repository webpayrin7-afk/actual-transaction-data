/**
 * 실험 정의 — 홈 요약과 /lab 전체 페이지가 함께 쓴다. 결과는 id로 매칭한다.
 */

export type LabExperimentId =
  | "volume-thermometer"
  | "area-84"
  | "price-bands"
  | "floor-mix"
  | "building-age"
  | "royal-floor"
  | "new-premium"
  | "size-ppp"
  | "direct-deal"
  | "weekday";

export interface LabExperimentDef {
  id: LabExperimentId;
  /** /lab#slug */
  slug: LabExperimentId;
  labNo: string;
  title: string;
  /** 섹션 탭용 짧은 이름 */
  shortTitle: string;
  question: string;
  /** 실험 방법 — 어떻게 셌는지, 무엇을 뺐는지. 내부 기록용(화면에 노출하지 않음) */
  method: string;
  /** A=기존 aggregate, B=bounded indexed query, C=full scan(제외) */
  computeClass: "A" | "B";
}

export const LAB_EXPERIMENTS: LabExperimentDef[] = [
  {
    id: "volume-thermometer",
    slug: "volume-thermometer",
    shortTitle: "온도계",
    labNo: "LAB 01",
    title: "거래량 온도계",
    question: "최근 거래가 가장 빠르게 늘어난 곳은 어디일까?",
    method:
      "시군구별 매매 건수를 최근 30일과 직전 30일로 나눠 비교했습니다. 신고가 늦게 들어오는 최근 5일은 빼고 셉니다. 표본이 적은 곳이 순위를 차지하지 않도록 최근 10건·직전 8건 이상인 곳만 봅니다.",
    computeClass: "B",
  },
  {
    id: "area-84",
    slug: "area-84",
    shortTitle: "84㎡",
    labNo: "LAB 02",
    title: "국민평형 84㎡",
    question: "국민평형은 어디에서 가장 많이 거래될까?",
    method: "전용 84㎡ 이상 85㎡ 미만 매매를 시군구별로 셌습니다.",
    computeClass: "B",
  },
  {
    id: "price-bands",
    slug: "price-bands",
    shortTitle: "가격대",
    labNo: "LAB 03",
    title: "요즘 많이 거래되는 가격대",
    question: "요즘 실제 거래는 어느 가격대에 가장 많이 몰려 있을까?",
    method: "최근 30일 매매 전부를 거래금액 구간으로 나눴습니다.",
    computeClass: "B",
  },
  {
    id: "floor-mix",
    slug: "floor-mix",
    shortTitle: "층",
    labNo: "LAB 04",
    title: "실제 거래가 많은 층",
    question: "아파트는 실제로 몇 층에서 가장 많이 거래될까?",
    method: "신고된 층으로 구간을 나눴습니다. 층 정보가 없거나 지하층은 뺐습니다.",
    computeClass: "B",
  },
  {
    id: "building-age",
    slug: "building-age",
    shortTitle: "연식",
    labNo: "LAB 05",
    title: "요즘 거래되는 아파트의 연식",
    question: "요즘 거래되는 아파트는 몇 년 차일까?",
    method: "계약 연도에서 건축년도를 빼 연식을 구했습니다. 건축년도가 없거나 이상한 거래는 뺐습니다.",
    computeClass: "B",
  },
  {
    id: "royal-floor",
    slug: "royal-floor",
    shortTitle: "로열층",
    labNo: "LAB 06",
    title: "로열층 프리미엄",
    question: "같은 단지·같은 평형이라면 몇 층이 얼마나 더 비쌀까?",
    method:
      "같은 단지·같은 전용면적(1㎡ 단위) 안에서 거래가 2건 이상인 묶음만 씁니다. 각 거래를 그 묶음의 중위가와 비교한 차이를 층 구간별 중앙값으로 냈습니다. 지역·단지 가격 차이는 비교에서 빠집니다.",
    computeClass: "B",
  },
  {
    id: "new-premium",
    slug: "new-premium",
    shortTitle: "신축",
    labNo: "LAB 07",
    title: "새 아파트 프리미엄",
    question: "새 아파트는 같은 동네 평균보다 평당 얼마나 비쌀까?",
    method:
      "거래마다 전용 평당가를 구하고, 같은 시군구의 최근 30일 평당 중위가와 비교했습니다. 그 차이를 연식 구간별 중앙값으로 냈습니다. 지역 차이를 덜어 내려는 비교이며 입지·브랜드 차이는 남아 있습니다.",
    computeClass: "B",
  },
  {
    id: "size-ppp",
    slug: "size-ppp",
    shortTitle: "평당가",
    labNo: "LAB 08",
    title: "작은 집의 평당가",
    question: "작은 집이 평당으로는 더 비쌀까?",
    method:
      "거래마다 전용 평당가를 같은 시군구 평당 중위가와 비교하고, 그 차이를 면적 구간별 중앙값으로 냈습니다.",
    computeClass: "B",
  },
  {
    id: "direct-deal",
    slug: "direct-deal",
    shortTitle: "직거래",
    labNo: "LAB 09",
    title: "직거래는 얼마에 거래될까",
    question: "중개 없이 직접 거래하면 가격이 달라질까?",
    method:
      "신고서의 거래 유형(직거래·중개거래)으로 나눴습니다. 가격 차이는 같은 단지·같은 면적에 중개거래가 함께 있는 직거래만 골라 그 중개거래 중위가와 비교했습니다. 직거래에는 가족 간 거래 등이 섞일 수 있습니다.",
    computeClass: "B",
  },
  {
    id: "weekday",
    slug: "weekday",
    shortTitle: "요일",
    labNo: "LAB 10",
    title: "계약하는 요일",
    question: "아파트 매매 계약은 무슨 요일에 가장 많이 할까?",
    method: "신고된 계약일의 요일을 셌습니다(한국 시간 기준).",
    computeClass: "B",
  },
];

export const LAB_FEATURED_ID: LabExperimentId = "volume-thermometer";

export function getLabDef(id: LabExperimentId): LabExperimentDef {
  const found = LAB_EXPERIMENTS.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown lab experiment: ${id}`);
  return found;
}
