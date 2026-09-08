import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { getDb, hasDb } from "@/lib/db/client";
import { aptDetailHref } from "@/lib/molit/apt";
import { formatComplexLocationLabel } from "@/lib/complexes/recent-views";
import { addDays } from "@/lib/market/keys";

/** 단지 discovery용 — 시장 이벤트 랭킹이 아님 */
export const ACTIVE_COMPLEX_WINDOW_DAYS = 30;
export const ACTIVE_COMPLEX_LIMIT = 8;

/**
 * 거래량 집계 identity (stats-feeds activeComplexes와 동일):
 * apt_name_norm | lawd_cd | dong
 */
export function activeComplexKey(
  aptNameNorm: string,
  lawdCd: string,
  dong: string,
): string {
  return `${aptNameNorm}|${lawdCd}|${dong}`;
}

export type ActiveComplexItem = {
  rank: number;
  aptName: string;
  aptNameNorm: string;
  lawdCd: string;
  gu: string;
  dong: string;
  regionLabel: string;
  recentCount: number;
  latestDealDate: string;
  href: string;
};

export type ActiveComplexesResponse = {
  asOfDate: string | null;
  fromDate: string | null;
  windowDays: number;
  dealType: "trade";
  items: ActiveComplexItem[];
  /** 기간 내 스캔한 매매 행 수 (디버그/투명성) */
  scannedRows: number;
  source: "db" | "cache" | "empty";
  note: string;
};

const READ_CACHE_TTL_MS = 5 * 60 * 1000;
let readCache: { expiresAt: number; data: ActiveComplexesResponse } | null =
  null;

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

function emptyResponse(note: string): ActiveComplexesResponse {
  return {
    asOfDate: null,
    fromDate: null,
    windowDays: ACTIVE_COMPLEX_WINDOW_DAYS,
    dealType: "trade",
    items: [],
    scannedRows: 0,
    source: "empty",
    note,
  };
}

/**
 * 최근 N일(계약일 deal_date) 매매 건수 TOP 단지.
 * idx_tx_type_deal_date로 기간만 읽어 GROUP BY — 전체 테이블 full scan 없음.
 */
export async function getActiveComplexes(): Promise<ActiveComplexesResponse> {
  if (readCache && readCache.expiresAt > Date.now()) {
    return { ...readCache.data, source: "cache" };
  }

  if (!hasDb()) {
    return emptyResponse("DB가 설정되지 않아 거래 활발 단지를 표시할 수 없습니다.");
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

  const fromDate = addDays(asOfDate, -(ACTIVE_COMPLEX_WINDOW_DAYS - 1));

  const countRes = await db.execute({
    sql: `SELECT COUNT(*) AS n
          FROM transactions
          WHERE deal_type = 'trade'
            AND deal_date >= ?
            AND deal_date <= ?`,
    args: [fromDate, asOfDate],
  });
  const scannedRows = Number(countRes.rows[0]?.n ?? 0);

  const topRes = await db.execute({
    sql: `SELECT
            apt_name_norm,
            lawd_cd,
            dong,
            MAX(apt_name) AS apt_name,
            MAX(gu) AS gu,
            COUNT(*) AS recent_count,
            MAX(deal_date) AS latest_deal_date
          FROM transactions
          WHERE deal_type = 'trade'
            AND deal_date >= ?
            AND deal_date <= ?
          GROUP BY apt_name_norm, lawd_cd, dong
          ORDER BY recent_count DESC, latest_deal_date DESC
          LIMIT ?`,
    args: [fromDate, asOfDate, ACTIVE_COMPLEX_LIMIT],
  });

  const items: ActiveComplexItem[] = topRes.rows.map((row, idx) => {
    const aptName = String(row.apt_name ?? "");
    const lawdCd = String(row.lawd_cd ?? "");
    const gu = String(row.gu ?? "");
    const dong = String(row.dong ?? "");
    const aptNameNorm = String(row.apt_name_norm ?? "");
    const slug = regionSlugFor(lawdCd, gu);
    return {
      rank: idx + 1,
      aptName,
      aptNameNorm,
      lawdCd,
      gu,
      dong,
      regionLabel: formatComplexLocationLabel({
        regionSlug: slug,
        gu,
        dong,
      }),
      recentCount: Number(row.recent_count ?? 0),
      latestDealDate: String(row.latest_deal_date ?? ""),
      href: aptDetailHref(aptName, slug, gu),
    };
  });

  const data: ActiveComplexesResponse = {
    asOfDate,
    fromDate,
    windowDays: ACTIVE_COMPLEX_WINDOW_DAYS,
    dealType: "trade",
    items,
    scannedRows,
    source: "db",
    note: "최근 30일 계약일(매매) 기준 거래건수입니다. 신고 지연으로 최신 구간이 낮게 보일 수 있으며, 시장 강세·약세 지표가 아닙니다.",
  };

  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data };
  return data;
}
