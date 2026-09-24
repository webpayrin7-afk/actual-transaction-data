import type { LabExperimentId } from "@/lib/lab/definitions";

export interface LabPeriod {
  /** 표시용: 최근 30일 · 2026.08.10 ~ 2026.09.08 */
  label: string;
  from: string;
  to: string;
  /** 거래량 온도계 직전 구간 */
  priorFrom?: string;
  priorTo?: string;
  priorLabel?: string;
}

export interface LabRankRow {
  rank: number;
  label: string;
  regionSlug: string;
  href: string;
  recentCount: number;
  priorCount?: number;
  increaseCount?: number;
  growthPct?: number | null;
  sharePct?: number | null;
}

export interface LabBucketRow {
  key: string;
  label: string;
  count: number;
  sharePct: number;
  /**
   * 비교형 실험(프리미엄·가격차)의 값 — 기준 대비 %(예: +4.2). 있으면 비중 대신 이 값을 그린다.
   * 표본이 부족하면 null.
   */
  deltaPct?: number | null;
}

export interface LabExperimentResult {
  id: LabExperimentId;
  period: LabPeriod;
  /** 질문에 대한 한 줄 답 (예: "과천시 +50%", "3억 미만 41.1%") */
  headline: string;
  insight: string;
  /** 순위형 (온도계·84㎡·직거래 지역) */
  ranks?: LabRankRow[];
  /** 분포형 (가격·층·연식·요일) 또는 비교형 (deltaPct) */
  buckets?: LabBucketRow[];
  /** 비교형이면 기준 설명 (예: "같은 단지·같은 면적 중위가 대비") */
  deltaBasis?: string;
  /** 분포 합계(unknown 제외 기준일 수 있음) */
  totalCount: number;
  /** unknown/제외 건수 */
  excludedCount?: number;
  excludedNote?: string;
}

export interface LabTimings {
  totalMs: number;
  queries: Record<string, number>;
}

export interface LabHomeResponse {
  source: "db" | "cache" | "empty";
  /** DB 최신 매매 계약일 */
  asOfDate: string | null;
  coverageLabel: string;
  coverageShort: string;
  dateBasisNote: string;
  featuredId: LabExperimentId;
  experiments: LabExperimentResult[];
  computedAt: string | null;
  timings?: LabTimings;
  warning?: string;
}
