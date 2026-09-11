import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { hasDiscoveryAtColumn } from "@/lib/db/discovery-axis";
import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { aptDetailHref } from "@/lib/molit/apt";
import {
  MARKET_COMPLEX_KEY_VERSION,
  DROP_THRESHOLD,
  addDays,
  typeKey,
} from "@/lib/market/keys";
import {
  formatSeoulDateTime,
  seoulDateOf,
  seoulDayBoundsUtc,
  seoulToday,
} from "@/lib/market/time";

const LIST_LIMIT = 8;
const HIGH_PRICE_MAN = 200_000; // 20억
const VOLUME_WINDOW_DAYS = 30;
const MIN_RECENT_VOLUME = 3;
const MIN_PRIOR_VOLUME = 1;
const MIN_VOLUME_GROWTH_RATIO = 1.5;
/** 스냅샷 메모리 캐시 (DB 스냅샷 읽기용) */
const READ_CACHE_TTL_MS = 60 * 1000;

export type MarketDealKind = "singoga" | "drop" | "high" | "surge";

export interface MarketDealItem {
  id: string;
  aptName: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  dealAmount: number;
  dealDate: string;
  href: string;
  priorMaxAmount: number | null;
  changeAmount: number | null;
  changePct: number | null;
  kind: MarketDealKind;
  kindLabel: string;
  /** 시스템 최초 확인 시각 (ISO). 신고일 아님 */
  firstSeenAt?: string | null;
}

export interface MarketVolumeItem {
  aptName: string;
  gu: string;
  dong: string;
  href: string;
  recentCount: number;
  priorCount: number;
  increaseCount: number;
  growthPct: number | null;
}

export interface MarketHomeResponse {
  source: "db" | "snapshot" | "empty";
  /** DB 최신 계약일 (참고) */
  asOfDate: string | null;
  /** 한국시간 기준 ‘오늘’ (신규 확인 필터) */
  discoveryDate: string | null;
  recentFrom: string | null;
  recentTo: string | null;
  dateBasisNote: string;
  computedAt?: string | null;
  /** 최종 업데이트 표시용 */
  lastUpdatedLabel?: string | null;
  complexKeyVersion?: string;
  discoveryReady: boolean;
  kpis: {
    /** 오늘 새로 확인된 거래 */
    newDealCount: number;
    singogaCount: number;
    dropCount: number;
    highCount: number;
    /** @deprecated 호환용 — volumeSurgeCount */
    volumeSurgeCount: number;
    notableCount: number;
  };
  singoga: MarketDealItem[];
  drops: MarketDealItem[];
  highDeals: MarketDealItem[];
  volumeSurges: MarketVolumeItem[];
  notables: MarketDealItem[];
  warning?: string;
}

interface RawTrade {
  id: string;
  lawdCd: string;
  dealDate: string;
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  dealAmount: number;
  firstSeenAt: string | null;
}

let readCache: { expiresAt: number; data: MarketHomeResponse } | null = null;
let volumeCache: { expiresAt: number; asOf: string; items: MarketVolumeItem[] } | null =
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

function hrefFor(row: {
  aptName: string;
  lawdCd: string;
  gu: string;
}): string {
  return aptDetailHref(row.aptName, regionSlugFor(row.lawdCd, row.gu), row.gu);
}

function emptyResponse(warning?: string): MarketHomeResponse {
  return {
    source: "empty",
    asOfDate: null,
    discoveryDate: seoulToday(),
    recentFrom: null,
    recentTo: null,
    dateBasisNote:
      "새로 확인된 거래는 집랩이 처음 확인한 날짜 기준이며 실제 계약일과 다릅니다.",
    computedAt: null,
    lastUpdatedLabel: null,
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    discoveryReady: false,
    kpis: {
      newDealCount: 0,
      singogaCount: 0,
      dropCount: 0,
      highCount: 0,
      volumeSurgeCount: 0,
      notableCount: 0,
    },
    singoga: [],
    drops: [],
    highDeals: [],
    volumeSurges: [],
    notables: [],
    warning,
  };
}

export async function readMarketHomeSnapshot(): Promise<MarketHomeResponse | null> {
  if (readCache && readCache.expiresAt > Date.now()) return readCache.data;
  if (!hasDb()) return null;
  await ensureSchema();
  const db = getDb();
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: `SELECT computed_at, as_of_date, payload FROM market_home_snapshots WHERE id = 1`,
      args: [],
    });
    const row = r.rows[0];
    if (!row?.payload) return null;
    const data = JSON.parse(String(row.payload)) as MarketHomeResponse;
    data.source = "snapshot";
    data.computedAt = String(row.computed_at ?? data.computedAt ?? "");
    data.lastUpdatedLabel = formatSeoulDateTime(data.computedAt);
    // 구버전 스냅샷 호환
    if (data.discoveryReady == null) data.discoveryReady = false;
    if (!data.kpis.newDealCount && data.kpis.newDealCount !== 0) {
      data.kpis.newDealCount = data.kpis.notableCount ?? 0;
    }
    if (data.kpis.highCount == null) data.kpis.highCount = 0;
    if (!data.highDeals) data.highDeals = [];
    if (!data.discoveryDate) data.discoveryDate = seoulToday();
    readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data };
    return data;
  } catch {
    return null;
  }
}

export async function saveMarketHomeSnapshot(
  data: MarketHomeResponse,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const computedAt = data.computedAt ?? new Date().toISOString();
  const payload = JSON.stringify({ ...data, source: "snapshot" });
  await db.execute({
    sql: `INSERT INTO market_home_snapshots (id, computed_at, as_of_date, payload)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            computed_at = excluded.computed_at,
            as_of_date = excluded.as_of_date,
            payload = excluded.payload`,
    args: [computedAt, data.asOfDate ?? "", payload],
  });
  readCache = {
    expiresAt: Date.now() + READ_CACHE_TTL_MS,
    data: { ...data, source: "snapshot", computedAt },
  };
}

async function computeVolumeSurges(asOfDate: string): Promise<MarketVolumeItem[]> {
  if (!asOfDate) return [];
  if (
    volumeCache &&
    volumeCache.asOf === asOfDate &&
    volumeCache.expiresAt > Date.now()
  ) {
    return volumeCache.items;
  }
  if (!hasDb()) return [];
  const db = getDb();
  if (!db) return [];
  const recentTo = asOfDate;
  const volumeMid = addDays(asOfDate, -VOLUME_WINDOW_DAYS);
  const volumeFrom = addDays(asOfDate, -(VOLUME_WINDOW_DAYS * 2 - 1));
  try {
    const result = await db.execute({
      sql: `SELECT
              apt_name_norm,
              lawd_cd,
              dong,
              MAX(apt_name) AS apt_name,
              MAX(gu) AS gu,
              SUM(CASE WHEN deal_date >= ? AND deal_date <= ? THEN 1 ELSE 0 END) AS recent_count,
              SUM(CASE WHEN deal_date >= ? AND deal_date < ? THEN 1 ELSE 0 END) AS prior_count
            FROM transactions
            WHERE deal_type = ?
              AND deal_date >= ?
              AND deal_date <= ?
            GROUP BY apt_name_norm, lawd_cd, dong
            HAVING recent_count >= ?
               AND prior_count >= ?
               AND recent_count * 1.0 / prior_count >= ?
            ORDER BY (recent_count - prior_count) DESC, recent_count DESC
            LIMIT ?`,
      args: [
        volumeMid,
        recentTo,
        volumeFrom,
        volumeMid,
        "trade",
        volumeFrom,
        recentTo,
        MIN_RECENT_VOLUME,
        MIN_PRIOR_VOLUME,
        MIN_VOLUME_GROWTH_RATIO,
        LIST_LIMIT,
      ],
    });
    const items: MarketVolumeItem[] = result.rows.map((row) => {
      const recentCount = Number(row.recent_count) || 0;
      const priorCount = Number(row.prior_count) || 0;
      const aptName = String(row.apt_name ?? "");
      const gu = String(row.gu ?? "");
      const lawdCd = String(row.lawd_cd ?? "");
      return {
        aptName,
        gu,
        dong: String(row.dong ?? ""),
        href: hrefFor({ aptName, lawdCd, gu }),
        recentCount,
        priorCount,
        increaseCount: recentCount - priorCount,
        growthPct:
          priorCount > 0
            ? Math.round(((recentCount - priorCount) / priorCount) * 1000) / 10
            : null,
      };
    });
    volumeCache = {
      expiresAt: Date.now() + READ_CACHE_TTL_MS,
      asOf: asOfDate,
      items,
    };
    return items;
  } catch (error) {
    console.warn("[market-home] volume surge read failed:", error);
    return [];
  }
}

function withVolumeSurges(
  payload: MarketHomeResponse,
  volumeSurges: MarketVolumeItem[],
): MarketHomeResponse {
  if (payload.volumeSurges.length > 0 && volumeSurges.length === 0) {
    return payload;
  }
  return {
    ...payload,
    volumeSurges,
    kpis: {
      ...payload.kpis,
      volumeSurgeCount: volumeSurges.length,
    },
  };
}

export async function getMarketHome(): Promise<MarketHomeResponse> {
  const snap = await readMarketHomeSnapshot();
  const asOfDate = snap?.asOfDate ?? null;
  let resolvedAsOf = asOfDate;
  if (!resolvedAsOf && hasDb()) {
    const db = getDb();
    if (db) {
      const maxRow = await db.execute({
        sql: `SELECT MAX(deal_date) AS max_d FROM transactions WHERE deal_type = ?`,
        args: ["trade"],
      });
      resolvedAsOf = String(maxRow.rows[0]?.max_d ?? "") || null;
    }
  }
  const volumeSurges = await computeVolumeSurges(resolvedAsOf ?? "");
  const payload = snap ?? (await computeMarketHome({ discoveryDay: "today" }));
  return withVolumeSurges(payload, volumeSurges);
}

/**
 * 홈 = 발견 시간축.
 * discovery_at(있으면) 또는 first_seen_at이 한국시간 ‘오늘’인 매매만 신규 피드에 포함.
 * NULL 행은 포함하지 않음 — bulk/backfill 대량 노출 방지.
 */
export async function computeMarketHome(opts?: {
  discoveryDay?: "today" | "latest";
}): Promise<MarketHomeResponse> {
  if (!hasDb()) {
    return emptyResponse("실거래 데이터를 불러올 수 없습니다.");
  }

  await ensureSchema();
  const db = getDb();
  if (!db) {
    return emptyResponse("실거래 데이터를 불러올 수 없습니다.");
  }

  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS max_d FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  const asOfDate = String(maxRow.rows[0]?.max_d ?? "");
  let discoveryDate = seoulToday();
  const useDiscoveryAt = await hasDiscoveryAtColumn(db);
  const activityCol = useDiscoveryAt ? "discovery_at" : "first_seen_at";
  if (opts?.discoveryDay === "latest") {
    const maxDisc = await db.execute({
      sql: `SELECT MAX(${activityCol}) AS max_d FROM transactions
            WHERE deal_type = ?
              AND ${activityCol} IS NOT NULL
              AND ${activityCol} != ''`,
      args: ["trade"],
    });
    const maxIso = String(maxDisc.rows[0]?.max_d ?? "");
    const latestDay = maxIso ? seoulDateOf(maxIso) : "";
    if (latestDay) discoveryDate = latestDay;
  }
  const { startIso, endIso } = seoulDayBoundsUtc(discoveryDate);

  if (!asOfDate) {
    return emptyResponse("적재된 매매 실거래가 없습니다.");
  }

  const coverage = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM transactions
          WHERE deal_type = ? AND ${activityCol} IS NOT NULL AND ${activityCol} != ''`,
    args: ["trade"],
  });
  const discoveryReady = Number(coverage.rows[0]?.cnt ?? 0) > 0;

  const newResult = await db.execute({
    sql: `SELECT id, lawd_cd, deal_date, apt_name, apt_name_norm, gu, dong,
                 exclusive_area, deal_amount, first_seen_at
                 ${useDiscoveryAt ? ", discovery_at" : ""}
          FROM transactions
          WHERE deal_type = ?
            AND ${activityCol} IS NOT NULL
            AND ${activityCol} != ''
            AND ${activityCol} >= ?
            AND ${activityCol} < ?
          ORDER BY deal_date ASC, id ASC`,
    args: ["trade", startIso, endIso],
  });

  const discovered: RawTrade[] = newResult.rows.map((row) => ({
    id: String(row.id),
    lawdCd: String(row.lawd_cd),
    dealDate: String(row.deal_date).slice(0, 10),
    aptName: String(row.apt_name),
    aptNameNorm: String(row.apt_name_norm),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
    firstSeenAt: row.first_seen_at == null ? null : String(row.first_seen_at),
  }));

  const computedAt = new Date().toISOString();
  const baseMeta = {
    asOfDate,
    discoveryDate,
    recentFrom: discoveryDate,
    recentTo: discoveryDate,
    dateBasisNote:
      "새로 확인된 거래는 집랩이 처음 확인한 날짜 기준이며 공식 신고일이나 계약일을 뜻하지 않습니다. 각 카드의 날짜와 시장동향은 계약일 기준입니다.",
    computedAt,
    lastUpdatedLabel: formatSeoulDateTime(computedAt),
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    discoveryReady,
  };

  if (!discoveryReady) {
    return {
      ...emptyResponse(
        "새 거래 확인 기록이 아직 준비되지 않았습니다. 다음 데이터 갱신부터 새로 확인된 거래가 표시됩니다.",
      ),
      ...baseMeta,
      source: "db",
      discoveryReady: false,
    };
  }

  if (discovered.length === 0) {
    return {
      source: "db",
      ...baseMeta,
      kpis: {
        newDealCount: 0,
        singogaCount: 0,
        dropCount: 0,
        highCount: 0,
        volumeSurgeCount: 0,
        notableCount: 0,
      },
      singoga: [],
      drops: [],
      highDeals: [],
      volumeSurges: [],
      notables: [],
      warning:
        "오늘(한국시간) 새로 확인된 매매가 아직 없습니다. 데이터 갱신 후 다시 확인해 주세요.",
    };
  }

  // 신고가/하락: 각 거래의 deal_date 이전 peak만 사용 (동일일 비연쇄).
  const byDealDate = new Map<string, RawTrade[]>();
  for (const tx of discovered) {
    const list = byDealDate.get(tx.dealDate) ?? [];
    list.push(tx);
    byDealDate.set(tx.dealDate, list);
  }

  const priorByTxId = new Map<string, number>();
  const dayEntries = [...byDealDate.entries()];
  const DAY_CONCURRENCY = 3;
  for (let i = 0; i < dayEntries.length; i += DAY_CONCURRENCY) {
    await Promise.all(
      dayEntries.slice(i, i + DAY_CONCURRENCY).map(async ([dealDate, dayTrades]) => {
        const norms = [...new Set(dayTrades.map((t) => t.aptNameNorm))];
        const peak = new Map<string, number>();
        const CHUNK = 100;
        for (let n = 0; n < norms.length; n += CHUNK) {
          const slice = norms.slice(n, n + CHUNK);
          const placeholders = slice.map(() => "?").join(",");
          const hist = await db.execute({
            sql: `SELECT apt_name_norm, lawd_cd, dong, exclusive_area,
                         MAX(deal_amount) AS max_amt
                  FROM transactions
                  WHERE deal_type = ?
                    AND deal_date < ?
                    AND apt_name_norm IN (${placeholders})
                  GROUP BY apt_name_norm, lawd_cd, dong, ROUND(exclusive_area * 100)`,
            args: ["trade", dealDate, ...slice],
          });
          for (const row of hist.rows) {
            const key = typeKey(
              String(row.apt_name_norm),
              String(row.lawd_cd),
              String(row.dong ?? ""),
              Number(row.exclusive_area) || 0,
            );
            peak.set(key, Number(row.max_amt) || 0);
          }
        }
        for (const tx of dayTrades) {
          const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
          priorByTxId.set(tx.id, peak.get(key) ?? 0);
        }
      }),
    );
  }

  const singoga: MarketDealItem[] = [];
  const drops: MarketDealItem[] = [];
  const highDeals: MarketDealItem[] = [];

  for (const tx of discovered) {
    const prior = priorByTxId.get(tx.id) ?? 0;
    const singogaFlag = prior > 0 && tx.dealAmount > prior;
    const dropFlag =
      prior > 0 && (tx.dealAmount - prior) / prior <= DROP_THRESHOLD;
    if (singogaFlag) {
      const changeAmount = tx.dealAmount - prior;
      singoga.push({
        id: tx.id,
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        exclusiveArea: tx.exclusiveArea,
        dealAmount: tx.dealAmount,
        dealDate: tx.dealDate,
        href: hrefFor(tx),
        priorMaxAmount: prior,
        changeAmount,
        changePct: Math.round((changeAmount / prior) * 1000) / 10,
        kind: "singoga",
        kindLabel: "신규 신고가",
        firstSeenAt: tx.firstSeenAt,
      });
    }
    if (dropFlag) {
      const changeAmount = tx.dealAmount - prior;
      drops.push({
        id: tx.id,
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        exclusiveArea: tx.exclusiveArea,
        dealAmount: tx.dealAmount,
        dealDate: tx.dealDate,
        href: hrefFor(tx),
        priorMaxAmount: prior,
        changeAmount,
        changePct: Math.round((changeAmount / prior) * 1000) / 10,
        kind: "drop",
        kindLabel: "신규 하락거래",
        firstSeenAt: tx.firstSeenAt,
      });
    }
    if (tx.dealAmount >= HIGH_PRICE_MAN) {
      highDeals.push({
        id: tx.id,
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        exclusiveArea: tx.exclusiveArea,
        dealAmount: tx.dealAmount,
        dealDate: tx.dealDate,
        href: hrefFor(tx),
        priorMaxAmount: prior > 0 ? prior : null,
        changeAmount: prior > 0 ? tx.dealAmount - prior : null,
        changePct:
          prior > 0
            ? Math.round(((tx.dealAmount - prior) / prior) * 1000) / 10
            : null,
        kind: "high",
        kindLabel: "신규 고가거래",
        firstSeenAt: tx.firstSeenAt,
      });
    }
  }

  singoga.sort((a, b) => (b.changeAmount ?? 0) - (a.changeAmount ?? 0));
  drops.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
  highDeals.sort((a, b) => b.dealAmount - a.dealAmount);

  const shownIds = new Set<string>([
    ...singoga.slice(0, LIST_LIMIT).map((i) => i.id),
    ...drops.slice(0, LIST_LIMIT).map((i) => i.id),
  ]);

  const notables: MarketDealItem[] = [
    ...singoga.slice(0, 4),
    ...drops.slice(0, 2),
    ...highDeals.filter((h) => !shownIds.has(h.id)).slice(0, 4),
  ]
    .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
    .sort(
      (a, b) =>
        (b.firstSeenAt ?? "").localeCompare(a.firstSeenAt ?? "") ||
        b.dealAmount - a.dealAmount,
    )
    .slice(0, LIST_LIMIT);

  return {
    source: "db",
    ...baseMeta,
    kpis: {
      newDealCount: discovered.length,
      singogaCount: singoga.length,
      dropCount: drops.length,
      highCount: highDeals.length,
      volumeSurgeCount: 0,
      notableCount: notables.length,
    },
    singoga: singoga.slice(0, LIST_LIMIT),
    drops: drops.slice(0, LIST_LIMIT),
    highDeals: highDeals.slice(0, LIST_LIMIT),
    volumeSurges: [],
    notables,
  };
}

export async function rebuildMarketHome(): Promise<MarketHomeResponse> {
  const data = await computeMarketHome();
  if (data.source !== "empty" || data.asOfDate) {
    try {
      await saveMarketHomeSnapshot(data);
    } catch (err) {
      console.warn("[market-home] snapshot save failed:", err);
    }
  }
  readCache = null;
  volumeCache = null;
  return data;
}

/** @deprecated alias */
export const rebuildMarketHomeSnapshot = rebuildMarketHome;
