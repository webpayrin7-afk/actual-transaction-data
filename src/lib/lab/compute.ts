import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import {
  METRO_LABELS,
  metroFromLawdNationwide,
  slugFromLawd,
} from "@/lib/constants/nationwide-lawd";
import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { labCoverageLabel, labCoverageShort } from "@/lib/lab/coverage";
import { LAB_FEATURED_ID, getLabDef, type LabExperimentId } from "@/lib/lab/definitions";
import type {
  LabBucketRow,
  LabExperimentResult,
  LabHomeResponse,
  LabRankRow,
} from "@/lib/lab/types";
import { addDays } from "@/lib/market/keys";

/**
 * 오늘의 실험실 (READ only).
 * - 최근 30일 전국 매매 행을 한 번 읽어 분포·비교 실험을 메모리에서 계산 (deal_type+deal_date 인덱스)
 * - 거래량 온도계: 같은 인덱스로 60일 구간을 시군구별 집계
 * - 추정·보간 없음. 표본 기준에 못 미치는 칸은 null로 두고 화면에서 '표본 부족'으로 보인다.
 */

/** 메모리 캐시 — 데이터는 하루 한 번 바뀐다 */
const READ_CACHE_TTL_MS = 30 * 60 * 1000;

/** 거래량 온도계: 신고 지연 말단을 피하려 최신 계약일에서 뺄 일수 */
const VOLUME_COMPARE_LAG_DAYS = 5;
const VOLUME_MIN_RECENT = 10;
const VOLUME_MIN_PRIOR = 8;
/** 비교형 실험 칸의 최소 표본 */
const MIN_CELL = 30;
/** 직거래 비중 순위의 최소 거래 수 */
const DIRECT_MIN_TRADES = 50;
const PYEONG_SQM = 3.3058;

type Band<T> = { key: string; label: string; test: (v: T) => boolean };

const PRICE_BANDS: Band<number>[] = [
  { key: "under3", label: "3억 미만", test: (a) => a < 30_000 },
  { key: "3-5", label: "3~5억", test: (a) => a >= 30_000 && a < 50_000 },
  { key: "5-7", label: "5~7억", test: (a) => a >= 50_000 && a < 70_000 },
  { key: "7-10", label: "7~10억", test: (a) => a >= 70_000 && a < 100_000 },
  { key: "10-15", label: "10~15억", test: (a) => a >= 100_000 && a < 150_000 },
  { key: "15plus", label: "15억 이상", test: (a) => a >= 150_000 },
];

const FLOOR_BANDS: Band<number>[] = [
  { key: "1-2", label: "1~2층", test: (f) => f >= 1 && f <= 2 },
  { key: "3-5", label: "3~5층", test: (f) => f >= 3 && f <= 5 },
  { key: "6-10", label: "6~10층", test: (f) => f >= 6 && f <= 10 },
  { key: "11-15", label: "11~15층", test: (f) => f >= 11 && f <= 15 },
  { key: "16-20", label: "16~20층", test: (f) => f >= 16 && f <= 20 },
  { key: "21plus", label: "21층 이상", test: (f) => f >= 21 },
];

const AGE_BANDS: Band<number>[] = [
  { key: "0-5", label: "5년 이하", test: (a) => a >= 0 && a <= 5 },
  { key: "6-10", label: "6~10년", test: (a) => a >= 6 && a <= 10 },
  { key: "11-20", label: "11~20년", test: (a) => a >= 11 && a <= 20 },
  { key: "21-30", label: "21~30년", test: (a) => a >= 21 && a <= 30 },
  { key: "31plus", label: "30년 초과", test: (a) => a > 30 },
];

const SIZE_BANDS: Band<number>[] = [
  { key: "u40", label: "전용 40㎡ 미만", test: (s) => s < 40 },
  { key: "40-60", label: "40~60㎡", test: (s) => s >= 40 && s < 60 },
  { key: "60-85", label: "60~85㎡", test: (s) => s >= 60 && s < 85 },
  { key: "85-135", label: "85~135㎡", test: (s) => s >= 85 && s < 135 },
  { key: "135plus", label: "135㎡ 이상", test: (s) => s >= 135 },
];

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

let readCache: { expiresAt: number; data: LabHomeResponse } | null = null;

/* ───────── helpers ───────── */

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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function signed(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;
}

function fmtN(n: number): string {
  return n.toLocaleString("ko-KR");
}

/** lawd_cd → 단지 마스터의 시군구 이름 (새 행정코드 51xxx·12xxx 등도 포함). 인스턴스별 캐시. */
let sigunguByLawd: Map<string, string> | null = null;

async function loadSigunguNames(db: NonNullable<ReturnType<typeof getDb>>): Promise<Map<string, string>> {
  if (sigunguByLawd) return sigunguByLawd;
  const r = await db.execute(
    `SELECT lawd_cd, MIN(sigungu) AS s FROM apt_complex_master
     WHERE sigungu IS NOT NULL AND sigungu <> '' GROUP BY lawd_cd`,
  );
  sigunguByLawd = new Map(r.rows.map((row) => [String(row.lawd_cd), String(row.s)]));
  return sigunguByLawd;
}

/** 광주·전남 통합 신코드(12xxx)의 구는 광주 */
function sidoShort(lawdCd: string): string {
  if (lawdCd.startsWith("12")) return "광주";
  const m = metroFromLawdNationwide(lawdCd);
  return m === "other" ? "" : METRO_LABELS[m];
}

/** "서울 강남구", "인천 서구", "성남시 분당구", "정선군" — 이름만으로 겹치는 "X구"에만 시도를 붙인다. */
function lawdLabel(lawdCd: string): string {
  // 지역 레지스트리(화성 새 구 등 최신 이름) 우선, 없으면 단지 마스터 시군구
  const name = districtNameFromCode(lawdCd) || sigunguByLawd?.get(lawdCd) || "";
  if (!name) return lawdCd;
  if (/^[^\s]+구$/.test(name)) {
    const sido = sidoShort(lawdCd);
    return sido ? `${sido} ${name}` : name;
  }
  return name;
}

function lawdSlug(lawdCd: string): string {
  return LAWD_TO_REGION[lawdCd]?.slug ?? slugFromLawd("", lawdCd);
}

function emptyLab(warning: string): LabHomeResponse {
  return {
    source: "empty",
    asOfDate: null,
    coverageLabel: labCoverageLabel(),
    coverageShort: labCoverageShort(),
    dateBasisNote: "계약일 기준입니다.",
    featuredId: LAB_FEATURED_ID,
    experiments: [],
    computedAt: null,
    warning,
  };
}

async function timed<T>(bag: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    bag[key] = Math.round(performance.now() - t0);
  }
}

function shareBuckets<T>(values: T[], bands: Band<T>[]): { buckets: LabBucketRow[]; known: number } {
  const counts = new Map<string, number>();
  let known = 0;
  for (const v of values) {
    const b = bands.find((x) => x.test(v));
    if (!b) continue;
    known += 1;
    counts.set(b.key, (counts.get(b.key) ?? 0) + 1);
  }
  return {
    known,
    buckets: bands.map((b) => ({
      key: b.key,
      label: b.label,
      count: counts.get(b.key) ?? 0,
      sharePct: sharePct(counts.get(b.key) ?? 0, known),
    })),
  };
}

/** 비교형: 각 칸의 (값/기준 − 1) 중앙값(%). 표본이 MIN_CELL 미만이면 null. */
function deltaBuckets<T>(
  samples: Array<{ v: T; ratio: number }>,
  bands: Band<T>[],
): { buckets: LabBucketRow[]; known: number } {
  const byBand = new Map<string, number[]>();
  for (const s of samples) {
    const b = bands.find((x) => x.test(s.v));
    if (!b) continue;
    const list = byBand.get(b.key) ?? [];
    list.push(s.ratio);
    byBand.set(b.key, list);
  }
  const known = [...byBand.values()].reduce((n, l) => n + l.length, 0);
  return {
    known,
    buckets: bands.map((b) => {
      const list = byBand.get(b.key) ?? [];
      const m = list.length >= MIN_CELL ? median(list) : null;
      return {
        key: b.key,
        label: b.label,
        count: list.length,
        sharePct: sharePct(list.length, known),
        deltaPct: m == null ? null : round1((m - 1) * 100),
      };
    }),
  };
}

function topShare(buckets: LabBucketRow[]): LabBucketRow | null {
  return [...buckets].sort((a, b) => b.count - a.count)[0] ?? null;
}

function extremes(buckets: LabBucketRow[]): { hi: LabBucketRow | null; lo: LabBucketRow | null } {
  const valid = buckets.filter((b) => b.deltaPct != null);
  if (valid.length === 0) return { hi: null, lo: null };
  const sorted = [...valid].sort((a, b) => b.deltaPct! - a.deltaPct!);
  return { hi: sorted[0]!, lo: sorted.at(-1)! };
}

/* ───────── main ───────── */

type Trade = {
  lawd: string;
  apt: string;
  area: number;
  floor: number | null;
  amount: number;
  buildYear: number | null;
  date: string;
  direct: boolean | null;
};

export async function getLabHome(): Promise<LabHomeResponse> {
  if (readCache && readCache.expiresAt > Date.now()) {
    return { ...readCache.data, source: "cache" };
  }
  if (!hasDb()) return emptyLab("DB가 설정되지 않아 실험실 데이터를 표시할 수 없습니다.");

  const tAll = performance.now();
  const timings: Record<string, number> = {};
  await ensureSchema();
  const db = getDb()!;

  const asOfDate = await timed(timings, "asOf", async () => {
    const meta = await db.execute(`SELECT as_of_date AS d FROM market_stats_meta WHERE id = 1`);
    const fromMeta = String(meta.rows[0]?.d ?? "");
    if (fromMeta) return fromMeta;
    const r = await db.execute(
      `SELECT MAX(deal_date) AS d FROM transactions
       WHERE deal_type = 'trade' AND deal_date IS NOT NULL AND deal_date != ''`,
    );
    return String(r.rows[0]?.d ?? "");
  });
  if (!asOfDate) return emptyLab("매매 거래 데이터가 없습니다.");

  const distTo = asOfDate;
  const distFrom = addDays(asOfDate, -29);
  const volTo = addDays(asOfDate, -VOLUME_COMPARE_LAG_DAYS);
  const volFrom = addDays(volTo, -29);
  const volPriorTo = addDays(volTo, -30);
  const volPriorFrom = addDays(volTo, -59);

  const [, volRows, tradeRows] = await Promise.all([
    // 이름표는 순위 라벨에만 필요 — 실패해도 코드로 표시
    loadSigunguNames(db).catch(() => new Map<string, string>()),
    timed(timings, "volume", async () => {
      const r = await db.execute({
        sql: `SELECT lawd_cd,
                     SUM(CASE WHEN deal_date >= ? THEN 1 ELSE 0 END) AS cur,
                     SUM(CASE WHEN deal_date < ? THEN 1 ELSE 0 END) AS prev
              FROM transactions
              WHERE deal_type = 'trade' AND deal_date >= ? AND deal_date <= ?
              GROUP BY lawd_cd`,
        args: [volFrom, volFrom, volPriorFrom, volTo],
      });
      return r.rows;
    }),
    timed(timings, "trades30", async () => {
      const r = await db.execute({
        sql: `SELECT lawd_cd, apt_name_norm, exclusive_area, floor, deal_amount, build_year,
                     deal_date, dealing_gbn
              FROM transactions
              WHERE deal_type = 'trade' AND deal_date >= ? AND deal_date <= ?`,
        args: [distFrom, distTo],
      });
      return r.rows;
    }),
  ]);

  const trades: Trade[] = [];
  for (const r of tradeRows) {
    const amount = Number(r.deal_amount);
    const area = Number(r.exclusive_area);
    if (!(amount > 0) || !(area > 0)) continue;
    const fl = Number(r.floor);
    const by = Number(r.build_year);
    const gbn = r.dealing_gbn == null ? "" : String(r.dealing_gbn);
    trades.push({
      lawd: String(r.lawd_cd),
      apt: String(r.apt_name_norm ?? ""),
      area,
      floor: Number.isFinite(fl) && fl >= 1 ? fl : null,
      amount,
      buildYear: Number.isFinite(by) && by >= 1960 ? by : null,
      date: String(r.deal_date),
      direct: gbn.includes("직거래") ? true : gbn.includes("중개") ? false : null,
    });
  }
  const period = { label: periodLabel(distFrom, distTo, 30), from: distFrom, to: distTo };
  const experiments: LabExperimentResult[] = [];

  // —— LAB 01 거래량 온도계 (전국 시군구) ——
  let volCur = 0;
  let volPrev = 0;
  const volAll = volRows.map((r) => {
    const lawd = String(r.lawd_cd);
    const cur = Number(r.cur) || 0;
    const prev = Number(r.prev) || 0;
    volCur += cur;
    volPrev += prev;
    return { lawd, cur, prev };
  });
  const volumeRanks: LabRankRow[] = volAll
    .map((a) => ({
      rank: 0,
      label: lawdLabel(a.lawd),
      regionSlug: lawdSlug(a.lawd),
      href: `/region/${lawdSlug(a.lawd)}`,
      recentCount: a.cur,
      priorCount: a.prev,
      increaseCount: a.cur - a.prev,
      growthPct: pctChange(a.cur, a.prev),
    }))
    .filter(
      (x) => x.recentCount >= VOLUME_MIN_RECENT && x.priorCount >= VOLUME_MIN_PRIOR && (x.growthPct ?? 0) > 0,
    )
    .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))
    .slice(0, 10)
    .map((x, i) => ({ ...x, rank: i + 1 }));
  const volTop = volumeRanks[0];
  const nationalVol = pctChange(volCur, volPrev);
  experiments.push({
    id: "volume-thermometer",
    period: {
      label: periodLabel(volFrom, volTo, 30),
      from: volFrom,
      to: volTo,
      priorFrom: volPriorFrom,
      priorTo: volPriorTo,
      priorLabel: periodLabel(volPriorFrom, volPriorTo, 30).replace("최근 30일", "직전 30일"),
    },
    headline: volTop ? `${volTop.label} +${volTop.growthPct}%` : "뚜렷한 급증 없음",
    insight: volTop
      ? `${volTop.label}의 매매가 직전 30일 ${fmtN(volTop.priorCount ?? 0)}건에서 ${fmtN(volTop.recentCount)}건으로 늘었습니다.${
          nationalVol != null ? ` 같은 기간 전국 매매는 ${signed(nationalVol)} 변했습니다.` : ""
        }`
      : "표본 기준을 넘으면서 거래가 늘어난 시군구가 이번 구간에는 없었습니다.",
    ranks: volumeRanks,
    totalCount: volCur,
  });

  // —— LAB 02 국민평형 84㎡ ——
  const a84 = new Map<string, number>();
  let a84Total = 0;
  for (const t of trades) {
    if (t.area >= 84 && t.area < 85) {
      a84Total += 1;
      a84.set(t.lawd, (a84.get(t.lawd) ?? 0) + 1);
    }
  }
  const areaRanks: LabRankRow[] = [...a84.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([lawd, c], i) => ({
      rank: i + 1,
      label: lawdLabel(lawd),
      regionSlug: lawdSlug(lawd),
      href: `/region/${lawdSlug(lawd)}`,
      recentCount: c,
      sharePct: sharePct(c, a84Total),
    }));
  const aTop = areaRanks[0];
  experiments.push({
    id: "area-84",
    period,
    headline: aTop ? `${aTop.label} ${fmtN(aTop.recentCount)}건` : "표본 부족",
    insight: aTop
      ? `최근 30일 전용 84㎡ 매매 ${fmtN(a84Total)}건 중 ${aTop.label}가 ${aTop.sharePct}%를 차지했습니다.`
      : "해당 기간 84㎡대 매매가 부족합니다.",
    ranks: areaRanks,
    totalCount: a84Total,
  });

  // —— LAB 03 가격대 ——
  const price = shareBuckets(trades.map((t) => t.amount), PRICE_BANDS);
  const pTop = topShare(price.buckets);
  experiments.push({
    id: "price-bands",
    period,
    headline: pTop ? `${pTop.label} ${pTop.sharePct}%` : "표본 부족",
    insight: pTop
      ? `최근 30일 매매 ${fmtN(price.known)}건 중 ${pTop.label} 거래가 ${fmtN(pTop.count)}건으로 가장 많았습니다.`
      : "해당 기간 매매가 부족합니다.",
    buckets: price.buckets,
    totalCount: price.known,
  });

  // —— LAB 04 층 ——
  const floorVals = trades.map((t) => t.floor).filter((f): f is number => f != null);
  const floor = shareBuckets(floorVals, FLOOR_BANDS);
  const fTop = topShare(floor.buckets);
  const floorUnknown = trades.length - floorVals.length;
  experiments.push({
    id: "floor-mix",
    period,
    headline: fTop ? `${fTop.label} ${fTop.sharePct}%` : "표본 부족",
    insight: fTop
      ? `층이 확인된 매매 ${fmtN(floor.known)}건 중 ${fTop.label} 거래가 가장 많았습니다.`
      : "해당 기간 매매가 부족합니다.",
    buckets: floor.buckets,
    totalCount: floor.known,
    excludedCount: floorUnknown,
    excludedNote: floorUnknown > 0 ? `층 정보 없음·지하층 ${fmtN(floorUnknown)}건 제외` : undefined,
  });

  // —— LAB 05 연식 ——
  const ageOf = (t: Trade) =>
    t.buildYear == null ? null : Number(t.date.slice(0, 4)) - t.buildYear;
  const ageVals = trades.map(ageOf).filter((a): a is number => a != null && a >= 0);
  const age = shareBuckets(ageVals, AGE_BANDS);
  const ageTop = topShare(age.buckets);
  const ageUnknown = trades.length - ageVals.length;
  experiments.push({
    id: "building-age",
    period,
    headline: ageTop ? `${ageTop.label} ${ageTop.sharePct}%` : "표본 부족",
    insight: ageTop
      ? `연식이 확인된 매매 ${fmtN(age.known)}건 중 ${ageTop.label} 아파트가 가장 많이 거래됐습니다.`
      : "해당 기간 매매가 부족합니다.",
    buckets: age.buckets,
    totalCount: age.known,
    excludedCount: ageUnknown,
    excludedNote: ageUnknown > 0 ? `건축년도 없음·비정상 ${fmtN(ageUnknown)}건 제외` : undefined,
  });

  // —— 공통 기준: 같은 단지·같은 면적 중위가, 같은 시군구 평당 중위가 ——
  const groupKey = (t: Trade) => `${t.lawd}|${t.apt}|${Math.round(t.area)}`;
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!t.apt) continue;
    const k = groupKey(t);
    const list = groups.get(k) ?? [];
    list.push(t);
    groups.set(k, list);
  }
  const groupMedian = new Map<string, number>();
  for (const [k, list] of groups) {
    if (list.length >= 2) groupMedian.set(k, median(list.map((t) => t.amount))!);
  }
  const ppp = (t: Trade) => t.amount / (t.area / PYEONG_SQM);
  const lawdPpp = new Map<string, number[]>();
  for (const t of trades) {
    const list = lawdPpp.get(t.lawd) ?? [];
    list.push(ppp(t));
    lawdPpp.set(t.lawd, list);
  }
  const lawdPppMedian = new Map<string, number>();
  for (const [l, list] of lawdPpp) {
    if (list.length >= 10) lawdPppMedian.set(l, median(list)!);
  }

  // —— LAB 06 로열층 프리미엄 ——
  const floorSamples: Array<{ v: number; ratio: number }> = [];
  for (const t of trades) {
    if (t.floor == null) continue;
    const m = groupMedian.get(groupKey(t));
    if (m) floorSamples.push({ v: t.floor, ratio: t.amount / m });
  }
  const royal = deltaBuckets(floorSamples, FLOOR_BANDS);
  const rx = extremes(royal.buckets);
  experiments.push({
    id: "royal-floor",
    period,
    headline:
      rx.hi && rx.lo && rx.hi.key !== rx.lo.key
        ? `${rx.hi.label} vs ${rx.lo.label} ${(rx.hi.deltaPct! - rx.lo.deltaPct!).toFixed(1)}%p`
        : "표본 부족",
    insight:
      rx.hi && rx.lo && rx.hi.key !== rx.lo.key
        ? `같은 단지·같은 평형 안에서 ${rx.hi.label}은 묶음 중위가보다 ${signed(rx.hi.deltaPct!)}, ${rx.lo.label}은 ${signed(rx.lo.deltaPct!)}에 거래됐습니다.`
        : "비교할 수 있는 같은 단지·같은 평형 거래가 부족합니다.",
    buckets: royal.buckets,
    deltaBasis: "같은 단지·같은 전용면적 중위가 대비",
    totalCount: royal.known,
  });

  // —— LAB 07 새 아파트 프리미엄 ——
  const ageSamples: Array<{ v: number; ratio: number }> = [];
  for (const t of trades) {
    const a = ageOf(t);
    const base = lawdPppMedian.get(t.lawd);
    if (a == null || a < 0 || !base) continue;
    ageSamples.push({ v: a, ratio: ppp(t) / base });
  }
  const newPrem = deltaBuckets(ageSamples, AGE_BANDS);
  const newest = newPrem.buckets[0];
  const oldest = newPrem.buckets.at(-1);
  experiments.push({
    id: "new-premium",
    period,
    headline: newest?.deltaPct != null ? `5년 이하 ${signed(newest.deltaPct)}` : "표본 부족",
    insight:
      newest?.deltaPct != null
        ? `준공 5년 이하 아파트는 같은 시군구 평당 중위가보다 ${signed(newest.deltaPct)}에 거래됐습니다.${
            oldest?.deltaPct != null ? ` 30년 넘은 아파트는 ${signed(oldest.deltaPct)}였습니다(재건축 기대가 섞일 수 있습니다).` : ""
          }`
        : "연식별로 비교할 표본이 부족합니다.",
    buckets: newPrem.buckets,
    deltaBasis: "같은 시군구 전용 평당 중위가 대비",
    totalCount: newPrem.known,
  });

  // —— LAB 08 작은 집의 평당가 ——
  const sizeSamples: Array<{ v: number; ratio: number }> = [];
  for (const t of trades) {
    const base = lawdPppMedian.get(t.lawd);
    if (base) sizeSamples.push({ v: t.area, ratio: ppp(t) / base });
  }
  const size = deltaBuckets(sizeSamples, SIZE_BANDS);
  const sx = extremes(size.buckets);
  experiments.push({
    id: "size-ppp",
    period,
    headline: sx.hi ? `${sx.hi.label} ${signed(sx.hi.deltaPct!)}` : "표본 부족",
    insight: sx.hi
      ? `평당가로 보면 ${sx.hi.label} 구간이 같은 시군구 중위보다 ${signed(sx.hi.deltaPct!)}로 가장 높았고, ${sx.lo!.label} 구간은 ${signed(sx.lo!.deltaPct!)}였습니다.`
      : "면적별로 비교할 표본이 부족합니다.",
    buckets: size.buckets,
    deltaBasis: "같은 시군구 전용 평당 중위가 대비",
    totalCount: size.known,
  });

  // —— LAB 09 직거래 ——
  const typed = trades.filter((t) => t.direct != null);
  const directs = typed.filter((t) => t.direct);
  const directShare = sharePct(directs.length, typed.length);
  // 같은 묶음에 중개거래가 있을 때만 직거래 가격을 그 중개거래 중위가와 비교
  const brokeredMedian = new Map<string, number>();
  for (const [k, list] of groups) {
    const brokered = list.filter((t) => t.direct === false).map((t) => t.amount);
    if (brokered.length >= 1) brokeredMedian.set(k, median(brokered)!);
  }
  const directRatios: number[] = [];
  for (const t of directs) {
    const m = t.apt ? brokeredMedian.get(groupKey(t)) : undefined;
    if (m) directRatios.push(t.amount / m);
  }
  const directGap = directRatios.length >= MIN_CELL ? round1((median(directRatios)! - 1) * 100) : null;
  const byLawd = new Map<string, { all: number; direct: number }>();
  for (const t of typed) {
    const a = byLawd.get(t.lawd) ?? { all: 0, direct: 0 };
    a.all += 1;
    if (t.direct) a.direct += 1;
    byLawd.set(t.lawd, a);
  }
  const directRanks: LabRankRow[] = [...byLawd.entries()]
    .filter(([, a]) => a.all >= DIRECT_MIN_TRADES)
    .map(([lawd, a]) => ({ lawd, ...a, share: sharePct(a.direct, a.all) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 10)
    .map((a, i) => ({
      rank: i + 1,
      label: lawdLabel(a.lawd),
      regionSlug: lawdSlug(a.lawd),
      href: `/region/${lawdSlug(a.lawd)}`,
      recentCount: a.direct,
      priorCount: a.all,
      sharePct: a.share,
    }));
  experiments.push({
    id: "direct-deal",
    period,
    headline: directGap != null ? `중개거래보다 ${signed(directGap)}` : `직거래 ${directShare}%`,
    insight: `최근 30일 매매의 ${directShare}%(${fmtN(directs.length)}건)가 직거래였습니다.${
      directGap != null
        ? ` 같은 단지·같은 면적의 중개거래와 비교하면 직거래는 중위 ${signed(directGap)}에 거래됐습니다(비교 가능 ${fmtN(directRatios.length)}건).`
        : ""
    }`,
    buckets: [
      { key: "direct", label: "직거래", count: directs.length, sharePct: directShare },
      {
        key: "brokered",
        label: "중개거래",
        count: typed.length - directs.length,
        sharePct: round1(100 - directShare),
      },
    ],
    ranks: directRanks,
    totalCount: typed.length,
    excludedCount: trades.length - typed.length,
    excludedNote:
      trades.length > typed.length ? `거래 유형 미기재 ${fmtN(trades.length - typed.length)}건 제외` : undefined,
  });

  // —— LAB 10 요일 ——
  const dayCounts = new Array<number>(7).fill(0);
  for (const t of trades) {
    // 계약일은 날짜만 있다 — 그 달력 날짜의 요일 (UTC 자정으로 읽으면 시간대 영향 없음)
    const d = new Date(`${t.date.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) dayCounts[d.getUTCDay()]! += 1;
  }
  const dayTotal = dayCounts.reduce((a, b) => a + b, 0);
  // 월요일부터
  const order = [1, 2, 3, 4, 5, 6, 0];
  const dayBuckets: LabBucketRow[] = order.map((i) => ({
    key: `d${i}`,
    label: `${WEEKDAYS[i]}요일`,
    count: dayCounts[i]!,
    sharePct: sharePct(dayCounts[i]!, dayTotal),
  }));
  const dTop = topShare(dayBuckets);
  const weekend = dayCounts[0]! + dayCounts[6]!;
  experiments.push({
    id: "weekday",
    period,
    headline: dTop ? `${dTop.label} ${dTop.sharePct}%` : "표본 부족",
    insight: dTop
      ? `매매 계약은 ${dTop.label}에 가장 많았고, 주말(토·일) 계약은 ${sharePct(weekend, dayTotal)}%였습니다.`
      : "해당 기간 매매가 부족합니다.",
    buckets: dayBuckets,
    totalCount: dayTotal,
  });

  for (const e of experiments) getLabDef(e.id);

  const data: LabHomeResponse = {
    source: "db",
    asOfDate,
    coverageLabel: labCoverageLabel(),
    coverageShort: labCoverageShort(),
    dateBasisNote:
      "국토교통부 실거래 신고 기준, 계약일 기준입니다. 최근 계약은 신고 기한(30일) 안이라 뒤늦게 더 들어올 수 있습니다.",
    featuredId: LAB_FEATURED_ID,
    experiments,
    computedAt: new Date().toISOString(),
    timings: { totalMs: Math.round(performance.now() - tAll), queries: timings },
  };
  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data };
  return data;
}

/** 테스트/벤치용 캐시 무효화 */
export function invalidateLabHomeCache(): void {
  readCache = null;
}

export type { LabExperimentId };
