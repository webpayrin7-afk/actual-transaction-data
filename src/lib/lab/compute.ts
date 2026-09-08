import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { isArea84Band } from "@/lib/apt/default-area";
import { labCoverageLabel, labCoverageShort } from "@/lib/lab/coverage";
import {
  LAB_FEATURED_ID,
  getLabDef,
  type LabExperimentId,
} from "@/lib/lab/definitions";
import type {
  LabBucketRow,
  LabExperimentResult,
  LabHomeResponse,
  LabRankRow,
} from "@/lib/lab/types";
import { addDays } from "@/lib/market/keys";

/** 메모리 캐시 — market-home과 동일 계열 */
const READ_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 최근 계약일 구간은 신고 지연으로 과소집계되기 쉬움.
 * 거래량 온도계 비교 창의 끝을 asOf에서 이 일수만큼 당긴다.
 * (5일은 미확정 말단을 피하면서도 표본이 과도하게 줄지 않는 균형)
 */
const VOLUME_COMPARE_LAG_DAYS = 5;

/** 표본이 너무 적은 지역이 증감률을 독점하지 않도록 */
const VOLUME_MIN_RECENT = 10;
const VOLUME_MIN_PRIOR = 8;

const PRICE_BANDS: { key: string; label: string; test: (man: number) => boolean }[] =
  [
    { key: "under3", label: "3억 미만", test: (a) => a < 30_000 },
    { key: "3-5", label: "3~5억", test: (a) => a >= 30_000 && a < 50_000 },
    { key: "5-7", label: "5~7억", test: (a) => a >= 50_000 && a < 70_000 },
    { key: "7-10", label: "7~10억", test: (a) => a >= 70_000 && a < 100_000 },
    { key: "10-15", label: "10~15억", test: (a) => a >= 100_000 && a < 150_000 },
    { key: "15plus", label: "15억 이상", test: (a) => a >= 150_000 },
  ];

const FLOOR_BANDS: { key: string; label: string; test: (f: number) => boolean }[] =
  [
    { key: "1-5", label: "1~5층", test: (f) => f >= 1 && f <= 5 },
    { key: "6-10", label: "6~10층", test: (f) => f >= 6 && f <= 10 },
    { key: "11-15", label: "11~15층", test: (f) => f >= 11 && f <= 15 },
    { key: "16-20", label: "16~20층", test: (f) => f >= 16 && f <= 20 },
    { key: "21plus", label: "21층 이상", test: (f) => f >= 21 },
  ];

const AGE_BANDS: {
  key: string;
  label: string;
  test: (age: number) => boolean;
}[] = [
  { key: "0-5", label: "5년 이하", test: (a) => a >= 0 && a <= 5 },
  { key: "6-10", label: "6~10년", test: (a) => a >= 6 && a <= 10 },
  { key: "11-20", label: "11~20년", test: (a) => a >= 11 && a <= 20 },
  { key: "21-30", label: "21~30년", test: (a) => a >= 21 && a <= 30 },
  { key: "31plus", label: "30년 초과", test: (a) => a > 30 },
];

let readCache: { expiresAt: number; data: LabHomeResponse } | null = null;

function fmtPeriodDot(iso: string): string {
  return `${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

function periodLabel(from: string, to: string, days: number): string {
  return `최근 ${days}일 · ${fmtPeriodDot(from)} ~ ${fmtPeriodDot(to)}`;
}

function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function sharePct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function districtLabel(lawdCd: string, fallbackName: string): string {
  const reg = LAWD_TO_REGION[lawdCd];
  if (!reg) return fallbackName || lawdCd;
  const dist = reg.districts.find((d) => d.code === lawdCd);
  if (dist && dist.name !== reg.name) return `${reg.name} ${dist.name}`;
  return reg.name;
}

function regionSlugFor(lawdCd: string): string {
  return LAWD_TO_REGION[lawdCd]?.slug ?? "";
}

function emptyLab(warning: string): LabHomeResponse {
  return {
    source: "empty",
    asOfDate: null,
    coverageLabel: labCoverageLabel(),
    coverageShort: labCoverageShort(),
    dateBasisNote:
      "계약일(deal date) 기준입니다. ‘오늘’은 콘텐츠 브랜드이며 당일 계약만을 의미하지 않습니다.",
    featuredId: LAB_FEATURED_ID,
    experiments: [],
    computedAt: null,
    warning,
  };
}

async function timed<T>(
  bag: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    bag[key] = Math.round(performance.now() - t0);
  }
}

function buildBuckets(
  counts: Record<string, number>,
  defs: { key: string; label: string }[],
  total: number,
): LabBucketRow[] {
  return defs.map((d) => ({
    key: d.key,
    label: d.label,
    count: counts[d.key] ?? 0,
    sharePct: sharePct(counts[d.key] ?? 0, total),
  }));
}

function topInsightFromBuckets(
  id: LabExperimentId,
  buckets: LabBucketRow[],
  total: number,
): string {
  const top = [...buckets].sort((a, b) => b.count - a.count)[0];
  if (!top || total <= 0) return "해당 기간 매매 거래가 부족합니다.";
  if (id === "price-bands") {
    return `최근 30일 매매 ${total.toLocaleString("ko-KR")}건 중 ${top.label} 구간이 ${top.sharePct}%(${top.count.toLocaleString("ko-KR")}건)로 가장 많았습니다.`;
  }
  if (id === "floor-mix") {
    return `최근 30일 매매에서 ${top.label} 거래가 ${top.sharePct}%로 가장 큰 비중을 차지했습니다.`;
  }
  if (id === "building-age") {
    return `최근 30일 매매 중 연식 ${top.label} 아파트가 ${top.sharePct}%로 가장 많았습니다.`;
  }
  return `${top.label}이(가) ${top.sharePct}%로 가장 많았습니다.`;
}

/**
 * 오늘의 실험실 홈 데이터 (READ only).
 * - Exp01: market_stats_daily_region 재사용 (class A)
 * - Exp02~05: deal_type+deal_date 인덱스 범위 쿼리 (class B)
 * - full historical scan / MOLIT / DB write 없음
 */
export async function getLabHome(): Promise<LabHomeResponse> {
  if (readCache && readCache.expiresAt > Date.now()) {
    return { ...readCache.data, source: "cache" };
  }

  if (!hasDb()) {
    return emptyLab("DB가 설정되지 않아 실험실 데이터를 표시할 수 없습니다.");
  }

  const tAll = performance.now();
  const timings: Record<string, number> = {};
  await ensureSchema();
  const db = getDb()!;

  const asOfDate = await timed(timings, "asOf", async () => {
    const meta = await db.execute(
      `SELECT as_of_date AS d FROM market_stats_meta WHERE id = 1`,
    );
    const fromMeta = String(meta.rows[0]?.d ?? "");
    if (fromMeta) return fromMeta;
    const r = await db.execute(
      `SELECT MAX(deal_date) AS d
       FROM transactions
       WHERE deal_type = 'trade' AND deal_date IS NOT NULL AND deal_date != ''`,
    );
    return String(r.rows[0]?.d ?? "");
  });

  if (!asOfDate) {
    return emptyLab("매매 거래 데이터가 없습니다.");
  }

  /** 분포 실험용: asOf 기준 최근 30일 (계약일) */
  const distTo = asOfDate;
  const distFrom = addDays(asOfDate, -29);

  /** 온도계: 신고 지연 보정된 비교 창 */
  const volTo = addDays(asOfDate, -VOLUME_COMPARE_LAG_DAYS);
  const volFrom = addDays(volTo, -29);
  const volPriorTo = addDays(volTo, -30);
  const volPriorFrom = addDays(volTo, -59);

  const [regionRows, area84Rows, distAgg] = await Promise.all([
    timed(timings, "volumeRegions", async () => {
      const r = await db.execute({
        sql: `SELECT day, lawd_cd, region_slug, region_name, trade_count
              FROM market_stats_daily_region
              WHERE day >= ? AND day <= ?`,
        args: [volPriorFrom, volTo],
      });
      return r.rows;
    }),
    timed(timings, "area84", async () => {
      const r = await db.execute({
        sql: `SELECT lawd_cd, COUNT(*) AS c
              FROM transactions
              WHERE deal_type = 'trade'
                AND deal_date >= ? AND deal_date <= ?
                AND exclusive_area >= 84 AND exclusive_area < 85
              GROUP BY lawd_cd
              ORDER BY c DESC`,
        args: [distFrom, distTo],
      });
      return r.rows;
    }),
    timed(timings, "distributions", async () => {
      const r = await db.execute({
        sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN deal_amount < 30000 THEN 1 ELSE 0 END) AS p_under3,
            SUM(CASE WHEN deal_amount >= 30000 AND deal_amount < 50000 THEN 1 ELSE 0 END) AS p_3_5,
            SUM(CASE WHEN deal_amount >= 50000 AND deal_amount < 70000 THEN 1 ELSE 0 END) AS p_5_7,
            SUM(CASE WHEN deal_amount >= 70000 AND deal_amount < 100000 THEN 1 ELSE 0 END) AS p_7_10,
            SUM(CASE WHEN deal_amount >= 100000 AND deal_amount < 150000 THEN 1 ELSE 0 END) AS p_10_15,
            SUM(CASE WHEN deal_amount >= 150000 THEN 1 ELSE 0 END) AS p_15plus,
            SUM(CASE WHEN floor BETWEEN 1 AND 5 THEN 1 ELSE 0 END) AS f_1_5,
            SUM(CASE WHEN floor BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS f_6_10,
            SUM(CASE WHEN floor BETWEEN 11 AND 15 THEN 1 ELSE 0 END) AS f_11_15,
            SUM(CASE WHEN floor BETWEEN 16 AND 20 THEN 1 ELSE 0 END) AS f_16_20,
            SUM(CASE WHEN floor >= 21 THEN 1 ELSE 0 END) AS f_21plus,
            SUM(CASE WHEN floor IS NULL OR floor <= 0 THEN 1 ELSE 0 END) AS f_unknown,
            SUM(CASE WHEN build_year IS NOT NULL AND build_year >= 1960
              AND CAST(substr(deal_date,1,4) AS INTEGER) - build_year BETWEEN 0 AND 5 THEN 1 ELSE 0 END) AS a_0_5,
            SUM(CASE WHEN build_year IS NOT NULL AND build_year >= 1960
              AND CAST(substr(deal_date,1,4) AS INTEGER) - build_year BETWEEN 6 AND 10 THEN 1 ELSE 0 END) AS a_6_10,
            SUM(CASE WHEN build_year IS NOT NULL AND build_year >= 1960
              AND CAST(substr(deal_date,1,4) AS INTEGER) - build_year BETWEEN 11 AND 20 THEN 1 ELSE 0 END) AS a_11_20,
            SUM(CASE WHEN build_year IS NOT NULL AND build_year >= 1960
              AND CAST(substr(deal_date,1,4) AS INTEGER) - build_year BETWEEN 21 AND 30 THEN 1 ELSE 0 END) AS a_21_30,
            SUM(CASE WHEN build_year IS NOT NULL AND build_year >= 1960
              AND CAST(substr(deal_date,1,4) AS INTEGER) - build_year > 30 THEN 1 ELSE 0 END) AS a_31plus,
            SUM(CASE WHEN build_year IS NULL OR build_year < 1960
              OR CAST(substr(deal_date,1,4) AS INTEGER) - build_year < 0 THEN 1 ELSE 0 END) AS a_unknown
          FROM transactions
          WHERE deal_type = 'trade' AND deal_date >= ? AND deal_date <= ?`,
        args: [distFrom, distTo],
      });
      return r.rows[0] ?? {};
    }),
  ]);

  // —— LAB 01 volume thermometer ——
  type VolAgg = {
    lawdCd: string;
    regionSlug: string;
    label: string;
    cur: number;
    prev: number;
  };
  const volMap = new Map<string, VolAgg>();
  for (const row of regionRows) {
    const lawdCd = String(row.lawd_cd);
    const day = String(row.day);
    const c = Number(row.trade_count) || 0;
    let a = volMap.get(lawdCd);
    if (!a) {
      a = {
        lawdCd,
        regionSlug: regionSlugFor(lawdCd) || String(row.region_slug ?? ""),
        label: districtLabel(lawdCd, String(row.region_name ?? "")),
        cur: 0,
        prev: 0,
      };
      volMap.set(lawdCd, a);
    }
    if (day >= volFrom && day <= volTo) a.cur += c;
    else if (day >= volPriorFrom && day <= volPriorTo) a.prev += c;
  }

  const volTotalCur = [...volMap.values()].reduce((s, x) => s + x.cur, 0);
  const volTotalPrev = [...volMap.values()].reduce((s, x) => s + x.prev, 0);

  const volumeRanks: LabRankRow[] = [...volMap.values()]
    .map((a) => ({
      rank: 0,
      label: a.label,
      regionSlug: a.regionSlug,
      href: a.regionSlug ? `/region/${a.regionSlug}` : "/regions",
      recentCount: a.cur,
      priorCount: a.prev,
      increaseCount: a.cur - a.prev,
      growthPct: pctChange(a.cur, a.prev),
    }))
    .filter(
      (x) =>
        x.recentCount >= VOLUME_MIN_RECENT &&
        (x.priorCount ?? 0) >= VOLUME_MIN_PRIOR &&
        (x.growthPct ?? 0) > 0,
    )
    .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))
    .slice(0, 5)
    .map((x, i) => ({ ...x, rank: i + 1 }));

  const volTop = volumeRanks[0];
  let volumeInsight: string;
  if (volTop) {
    volumeInsight = `최근 30일 ${volTop.label}의 매매 거래량은 직전 30일보다 ${volTop.growthPct}% 증가했습니다(${volTop.priorCount}→${volTop.recentCount}건).`;
    if (volTotalPrev > 0 && volTotalCur < volTotalPrev) {
      volumeInsight += ` 같은 기간 제공 지역 전체 거래량은 직전 대비 감소했습니다.`;
    }
  } else {
    volumeInsight =
      "최소 표본을 충족하며 직전 30일보다 거래량이 늘어난 지역이 이번 창에서는 많지 않았습니다.";
  }

  const volumeResult: LabExperimentResult = {
    id: "volume-thermometer",
    period: {
      label: periodLabel(volFrom, volTo, 30),
      from: volFrom,
      to: volTo,
      priorFrom: volPriorFrom,
      priorTo: volPriorTo,
      priorLabel: periodLabel(volPriorFrom, volPriorTo, 30).replace(
        "최근 30일",
        "직전 30일",
      ),
    },
    insight: volumeInsight,
    ranks: volumeRanks,
    totalCount: volTotalCur,
  };

  // —— LAB 02 area 84 ——
  type AreaAgg = { slug: string; label: string; count: number };
  const areaBySlug = new Map<string, AreaAgg>();
  let area84Total = 0;
  for (const row of area84Rows) {
    const lawdCd = String(row.lawd_cd);
    const c = Number(row.c) || 0;
    area84Total += c;
    const reg = LAWD_TO_REGION[lawdCd];
    const slug = reg?.slug ?? String(lawdCd);
    const label = reg?.name ?? districtLabel(lawdCd, lawdCd);
    const cur = areaBySlug.get(slug) ?? { slug, label, count: 0 };
    cur.count += c;
    areaBySlug.set(slug, cur);
  }
  // sanity: isArea84Band kept in sync with SQL (>=84 && <85)
  void isArea84Band;

  const areaRanks: LabRankRow[] = [...areaBySlug.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((a, i) => ({
      rank: i + 1,
      label: a.label,
      regionSlug: a.slug,
      href: `/region/${a.slug}`,
      recentCount: a.count,
      sharePct: sharePct(a.count, area84Total),
    }));

  const areaTop = areaRanks[0];
  const areaInsight = areaTop
    ? `최근 30일 전용 84㎡(84㎡ 이상~85㎡ 미만) 매매 ${area84Total.toLocaleString("ko-KR")}건 중 ${areaTop.label}가 ${areaTop.recentCount.toLocaleString("ko-KR")}건(${areaTop.sharePct}%)으로 가장 많았습니다.`
    : "해당 기간 84㎡대 매매 거래가 부족합니다.";

  const areaResult: LabExperimentResult = {
    id: "area-84",
    period: {
      label: periodLabel(distFrom, distTo, 30),
      from: distFrom,
      to: distTo,
    },
    insight: areaInsight,
    ranks: areaRanks,
    totalCount: area84Total,
  };

  // —— LAB 03~05 from distAgg ——
  const total = Number(distAgg.total) || 0;
  const priceCounts: Record<string, number> = {
    under3: Number(distAgg.p_under3) || 0,
    "3-5": Number(distAgg.p_3_5) || 0,
    "5-7": Number(distAgg.p_5_7) || 0,
    "7-10": Number(distAgg.p_7_10) || 0,
    "10-15": Number(distAgg.p_10_15) || 0,
    "15plus": Number(distAgg.p_15plus) || 0,
  };
  const priceBuckets = buildBuckets(priceCounts, PRICE_BANDS, total);
  const priceResult: LabExperimentResult = {
    id: "price-bands",
    period: {
      label: periodLabel(distFrom, distTo, 30),
      from: distFrom,
      to: distTo,
    },
    insight: topInsightFromBuckets("price-bands", priceBuckets, total),
    buckets: priceBuckets,
    totalCount: total,
  };

  const floorUnknown = Number(distAgg.f_unknown) || 0;
  const floorKnown = total - floorUnknown;
  const floorCounts: Record<string, number> = {
    "1-5": Number(distAgg.f_1_5) || 0,
    "6-10": Number(distAgg.f_6_10) || 0,
    "11-15": Number(distAgg.f_11_15) || 0,
    "16-20": Number(distAgg.f_16_20) || 0,
    "21plus": Number(distAgg.f_21plus) || 0,
  };
  const floorBuckets = buildBuckets(floorCounts, FLOOR_BANDS, floorKnown);
  const floorResult: LabExperimentResult = {
    id: "floor-mix",
    period: {
      label: periodLabel(distFrom, distTo, 30),
      from: distFrom,
      to: distTo,
    },
    insight: topInsightFromBuckets("floor-mix", floorBuckets, floorKnown),
    buckets: floorBuckets,
    totalCount: floorKnown,
    excludedCount: floorUnknown,
    excludedNote:
      floorUnknown > 0
        ? `층 정보 없음 ${floorUnknown.toLocaleString("ko-KR")}건 제외`
        : undefined,
  };

  const ageUnknown = Number(distAgg.a_unknown) || 0;
  const ageKnown = total - ageUnknown;
  const ageCounts: Record<string, number> = {
    "0-5": Number(distAgg.a_0_5) || 0,
    "6-10": Number(distAgg.a_6_10) || 0,
    "11-20": Number(distAgg.a_11_20) || 0,
    "21-30": Number(distAgg.a_21_30) || 0,
    "31plus": Number(distAgg.a_31plus) || 0,
  };
  const ageBuckets = buildBuckets(ageCounts, AGE_BANDS, ageKnown);
  const ageResult: LabExperimentResult = {
    id: "building-age",
    period: {
      label: periodLabel(distFrom, distTo, 30),
      from: distFrom,
      to: distTo,
    },
    insight: topInsightFromBuckets("building-age", ageBuckets, ageKnown),
    buckets: ageBuckets,
    totalCount: ageKnown,
    excludedCount: ageUnknown,
    excludedNote:
      ageUnknown > 0
        ? `연식 미상·비정상(build_year NULL/1960 미만/미래) ${ageUnknown.toLocaleString("ko-KR")}건 제외`
        : undefined,
  };

  const experiments = [
    volumeResult,
    areaResult,
    priceResult,
    floorResult,
    ageResult,
  ];

  // ensure defs exist
  for (const e of experiments) getLabDef(e.id);

  const data: LabHomeResponse = {
    source: "db",
    asOfDate,
    coverageLabel: labCoverageLabel(),
    coverageShort: labCoverageShort(),
    dateBasisNote:
      "계약일(deal date) 기준입니다. 거래량 온도계는 신고 지연을 고려해 최신 계약일에서 5일을 뺀 창으로 직전 30일과 비교합니다. ‘오늘’은 콘텐츠 브랜드이며 당일 계약만을 의미하지 않습니다.",
    featuredId: LAB_FEATURED_ID,
    experiments,
    computedAt: new Date().toISOString(),
    timings: {
      totalMs: Math.round(performance.now() - tAll),
      queries: timings,
    },
  };

  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data };
  return data;
}

/** 테스트/벤치용 캐시 무효화 */
export function invalidateLabHomeCache(): void {
  readCache = null;
}
