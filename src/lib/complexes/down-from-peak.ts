import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { normalizeAreaKey } from "@/lib/apt/default-area";
import { getDb, hasDb } from "@/lib/db/client";
import { aptDetailHref } from "@/lib/molit/apt";
import { formatComplexLocationLabel } from "@/lib/complexes/recent-views";
import { addDays } from "@/lib/market/keys";

/** 최근 실거래 신선도 — 계약일(deal_date) 기준 */
export const DOWN_FROM_PEAK_FRESHNESS_DAYS = 90;
/** 고점 대비 최소 하락 비율 (latest <= peak * 0.9) */
export const DOWN_FROM_PEAK_RATIO = 0.9;
export const DOWN_FROM_PEAK_LIMIT = 10;

export type DownFromPeakItem = {
  rank: number;
  aptName: string;
  aptNameNorm: string;
  lawdCd: string;
  gu: string;
  dong: string;
  regionLabel: string;
  exclusiveArea: number;
  areaKey: string;
  latestAmount: number;
  peakAmount: number;
  dropAmount: number;
  /** (latest - peak) / peak * 100, 예: -19.6 */
  dropPct: number;
  latestDealDate: string;
  href: string;
};

export type DownFromPeakResponse = {
  asOfDate: string | null;
  fromDate: string | null;
  freshnessDays: number;
  thresholdPct: number;
  dealType: "trade";
  items: DownFromPeakItem[];
  /** 90일 창에서 단지+면적 그룹 수 */
  candidateGroups: number;
  source: "db" | "cache" | "empty";
  note: string;
};

const READ_CACHE_TTL_MS = 5 * 60 * 1000;
let readCache: { expiresAt: number; data: DownFromPeakResponse } | null = null;

function regionSlugFor(lawdCd: string, gu: string): string {
  const byLawd = LAWD_TO_REGION[lawdCd];
  if (byLawd) return byLawd.slug;
  const found = Object.values(LAWD_TO_REGION).find(
    (r) =>
      gu.includes(r.name) ||
      r.districts.some((d) => gu.includes(d.name) || d.name.includes(gu)),
  );
  return found?.slug ?? "seoul-gangnam";
}

function emptyResponse(note: string): DownFromPeakResponse {
  return {
    asOfDate: null,
    fromDate: null,
    freshnessDays: DOWN_FROM_PEAK_FRESHNESS_DAYS,
    thresholdPct: -Math.round((1 - DOWN_FROM_PEAK_RATIO) * 1000) / 10,
    dealType: "trade",
    items: [],
    candidateGroups: 0,
    source: "empty",
    note,
  };
}

function groupKey(
  aptNameNorm: string,
  lawdCd: string,
  dong: string,
  area100: number,
): string {
  return `${aptNameNorm}|${lawdCd}|${dong}|${area100}`;
}

/**
 * 고점 대비 내려온 단지 (단지+전용면적 단위).
 *
 * - peak: 전체 과거 매매 MAX(deal_amount)
 * - latest: 최근 N일 내 동일 identity의 최신 매매 (deal_date DESC, id DESC)
 * - 조건: latest <= peak * 0.9
 * - 정렬: dropPct ASC(하락 큰 순), latestDealDate DESC, latestAmount DESC
 *
 * idx_tx_type_deal_date로 최근 창만 읽고, peak는 deal_type='trade' 집계 1회.
 * 모듈 캐시 5분 — request마다 전체 테이블을 JS로 스캔하지 않음.
 */
export async function getDownFromPeakComplexes(): Promise<DownFromPeakResponse> {
  if (readCache && readCache.expiresAt > Date.now()) {
    return { ...readCache.data, source: "cache" };
  }

  if (!hasDb()) {
    return emptyResponse(
      "DB가 설정되지 않아 고점 대비 내려온 단지를 표시할 수 없습니다.",
    );
  }

  const db = getDb()!;
  const asOfRes = await db.execute(
    `SELECT MAX(deal_date) AS d
     FROM transactions
     WHERE deal_type = 'trade' AND deal_date IS NOT NULL AND deal_date != ''`,
  );
  const asOfDate = String(asOfRes.rows[0]?.d ?? "");
  if (!asOfDate) {
    return emptyResponse("매매 거래 데이터가 없습니다.");
  }

  const fromDate = addDays(asOfDate, -(DOWN_FROM_PEAK_FRESHNESS_DAYS - 1));

  // 1) 최근 창: 단지+면적별 최신 매매 1건 (동일일 다건 → id DESC로 결정적 선택)
  const latestRes = await db.execute({
    sql: `
      WITH ranked AS (
        SELECT
          apt_name,
          apt_name_norm,
          lawd_cd,
          gu,
          dong,
          exclusive_area,
          ROUND(exclusive_area * 100) AS area100,
          deal_amount,
          deal_date,
          id,
          ROW_NUMBER() OVER (
            PARTITION BY apt_name_norm, lawd_cd, IFNULL(dong, ''), ROUND(exclusive_area * 100)
            ORDER BY deal_date DESC, id DESC
          ) AS rn
        FROM transactions
        WHERE deal_type = 'trade'
          AND deal_date >= ?
          AND deal_date <= ?
          AND exclusive_area IS NOT NULL
          AND exclusive_area > 0
          AND deal_amount > 0
      )
      SELECT
        apt_name,
        apt_name_norm,
        lawd_cd,
        gu,
        dong,
        exclusive_area,
        area100,
        deal_amount AS latest_amount,
        deal_date AS latest_deal_date
      FROM ranked
      WHERE rn = 1
    `,
    args: [fromDate, asOfDate],
  });

  const candidateGroups = latestRes.rows.length;
  if (candidateGroups === 0) {
    return emptyResponse(
      "최근 거래 기준으로 고점 대비 10% 이상 내려온 단지가 없습니다.",
    );
  }

  // 2) 전체 매매 historical peak (단지+면적) — 1회 집계 후 메모리 join
  const peakRes = await db.execute(`
    SELECT
      apt_name_norm,
      lawd_cd,
      IFNULL(dong, '') AS dong,
      ROUND(exclusive_area * 100) AS area100,
      MAX(deal_amount) AS peak_amount
    FROM transactions
    WHERE deal_type = 'trade'
      AND exclusive_area IS NOT NULL
      AND exclusive_area > 0
      AND deal_amount > 0
    GROUP BY apt_name_norm, lawd_cd, IFNULL(dong, ''), ROUND(exclusive_area * 100)
  `);

  const peakMap = new Map<string, number>();
  for (const row of peakRes.rows) {
    peakMap.set(
      groupKey(
        String(row.apt_name_norm ?? ""),
        String(row.lawd_cd ?? ""),
        String(row.dong ?? ""),
        Number(row.area100) || 0,
      ),
      Number(row.peak_amount) || 0,
    );
  }

  type Cand = {
    aptName: string;
    aptNameNorm: string;
    lawdCd: string;
    gu: string;
    dong: string;
    exclusiveArea: number;
    areaKey: string;
    latestAmount: number;
    peakAmount: number;
    dropAmount: number;
    dropPct: number;
    latestDealDate: string;
  };

  const candidates: Cand[] = [];
  for (const row of latestRes.rows) {
    const aptNameNorm = String(row.apt_name_norm ?? "");
    const lawdCd = String(row.lawd_cd ?? "");
    const dong = String(row.dong ?? "");
    const area100 = Number(row.area100) || 0;
    const exclusiveArea = Number(row.exclusive_area) || 0;
    const latestAmount = Number(row.latest_amount) || 0;
    const peakAmount =
      peakMap.get(groupKey(aptNameNorm, lawdCd, dong, area100)) ?? 0;

    if (peakAmount <= 0 || latestAmount <= 0) continue;
    // 최신 거래가 고점인 경우(또는 고점 대비 -10% 미만) 제외
    if (latestAmount > peakAmount * DOWN_FROM_PEAK_RATIO) continue;

    const dropAmount = latestAmount - peakAmount;
    const dropPct = (dropAmount / peakAmount) * 100;
    candidates.push({
      aptName: String(row.apt_name ?? ""),
      aptNameNorm,
      lawdCd,
      gu: String(row.gu ?? ""),
      dong,
      exclusiveArea,
      areaKey: normalizeAreaKey(exclusiveArea),
      latestAmount,
      peakAmount,
      dropAmount,
      dropPct,
      latestDealDate: String(row.latest_deal_date ?? ""),
    });
  }

  candidates.sort((a, b) => {
    if (a.dropPct !== b.dropPct) return a.dropPct - b.dropPct;
    if (a.latestDealDate !== b.latestDealDate) {
      return b.latestDealDate.localeCompare(a.latestDealDate);
    }
    if (a.latestAmount !== b.latestAmount) return b.latestAmount - a.latestAmount;
    return `${a.aptNameNorm}|${a.lawdCd}|${a.dong}|${a.areaKey}`.localeCompare(
      `${b.aptNameNorm}|${b.lawdCd}|${b.dong}|${b.areaKey}`,
    );
  });

  const items: DownFromPeakItem[] = candidates
    .slice(0, DOWN_FROM_PEAK_LIMIT)
    .map((c, idx) => {
      const slug = regionSlugFor(c.lawdCd, c.gu);
      return {
        rank: idx + 1,
        aptName: c.aptName,
        aptNameNorm: c.aptNameNorm,
        lawdCd: c.lawdCd,
        gu: c.gu,
        dong: c.dong,
        regionLabel: formatComplexLocationLabel({
          regionSlug: slug,
          gu: c.gu,
          dong: c.dong,
        }),
        exclusiveArea: c.exclusiveArea,
        areaKey: c.areaKey,
        latestAmount: c.latestAmount,
        peakAmount: c.peakAmount,
        dropAmount: c.dropAmount,
        dropPct: Math.round(c.dropPct * 10) / 10,
        latestDealDate: c.latestDealDate,
        href: aptDetailHref(c.aptName, slug, c.gu, c.areaKey),
      };
    });

  const data: DownFromPeakResponse = {
    asOfDate,
    fromDate,
    freshnessDays: DOWN_FROM_PEAK_FRESHNESS_DAYS,
    thresholdPct: -Math.round((1 - DOWN_FROM_PEAK_RATIO) * 1000) / 10,
    dealType: "trade",
    items,
    candidateGroups,
    source: "db",
    note:
      "같은 단지·전용면적의 최근 매매 실거래가와 과거 최고 매매가를 비교합니다. 실시간 호가가 아니며, 월세·전세는 포함하지 않습니다.",
  };

  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data };

  if (items.length === 0) {
    return {
      ...data,
      note: "최근 거래 기준으로 고점 대비 10% 이상 내려온 단지가 없습니다.",
    };
  }

  return data;
}
