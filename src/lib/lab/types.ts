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
}

export interface LabExperimentResult {
  id: LabExperimentId;
  period: LabPeriod;
  insight: string;
  /** 순위형 (온도계·84㎡) */
  ranks?: LabRankRow[];
  /** 분포형 (가격·층·연식) */
  buckets?: LabBucketRow[];
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
