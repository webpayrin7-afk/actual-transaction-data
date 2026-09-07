import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { aptDetailHref } from "@/lib/molit/apt";

const RECENT_DEAL_DAYS = 14;
const VOLUME_WINDOW_DAYS = 30;
const DROP_THRESHOLD = -0.1; // −10% 이상 (상한 컷오프 없음 — 단지 키 강화로 대체)
const LIST_LIMIT = 8;
const HIGH_PRICE_MAN = 200_000; // 20억
const MIN_RECENT_VOLUME = 3;
const MIN_PRIOR_VOLUME = 1;
const MIN_VOLUME_GROWTH_RATIO = 1.5;
/** 스냅샷 메모리 캐시 (DB 스냅샷 읽기용, 계산용 아님) */
const READ_CACHE_TTL_MS = 60 * 1000;

/**
 * 단지·타입 식별 키
 * - 변경 전: apt_name_norm + gu + area (동명 단지 혼동)
 * - 변경 후: apt_name_norm + lawd_cd + dong + area
 *   lawd_cd·dong으로 같은 구의 다른 “대우” 등을 분리. jibun은 동일 단지 내에서도
 *   필지가 갈라지는 경우가 있어 키에 넣지 않음.
 */
export const MARKET_COMPLEX_KEY_VERSION = "apt_norm|lawd_cd|dong|area100";

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
  asOfDate: string | null;
  recentFrom: string | null;
  recentTo: string | null;
  dateBasisNote: string;
  computedAt?: string | null;
  complexKeyVersion?: string;
  kpis: {
    singogaCount: number;
    dropCount: number;
    volumeSurgeCount: number;
    notableCount: number;
  };
  singoga: MarketDealItem[];
  drops: MarketDealItem[];
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
}

let readCache: { expiresAt: number; data: MarketHomeResponse } | null = null;

function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

function typeKey(
  norm: string,
  lawdCd: string,
  dong: string,
  sqm: number,
): string {
  return `${norm}|${lawdCd}|${dong}|${areaKey(sqm)}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    recentFrom: null,
    recentTo: null,
    dateBasisNote:
      "계약일(deal_date) 기준입니다. 국토부 신고·적재 시차로 ‘오늘’과 다를 수 있습니다.",
    computedAt: null,
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    kpis: {
      singogaCount: 0,
      dropCount: 0,
      volumeSurgeCount: 0,
      notableCount: 0,
    },
    singoga: [],
    drops: [],
    volumeSurges: [],
    notables: [],
    warning,
  };
}

/** 홈 API — DB 스냅샷만 읽는다 (대규모 MAX 계산 없음). */
export async function getMarketHome(): Promise<MarketHomeResponse> {
  if (readCache && readCache.expiresAt > Date.now()) {
    return readCache.data;
  }

  if (!hasDb()) {
    return emptyResponse("실거래 DB가 연결되지 않았습니다.");
  }

  await ensureSchema();
  const snapshot = await readMarketHomeSnapshot();
  if (snapshot) {
    readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data: snapshot };
    return snapshot;
  }

  // 스냅샷 없을 때만 1회 계산 후 저장 (부트스트랩)
  const computed = await computeMarketHome();
  try {
    await saveMarketHomeSnapshot(computed);
  } catch (err) {
    console.warn("[market-home] snapshot save failed:", err);
  }
  const withSource: MarketHomeResponse = {
    ...computed,
    source: computed.source === "empty" ? "empty" : "db",
    warning:
      computed.warning ??
      "시장 스냅샷이 없어 방금 계산했습니다. sync 후 db:market 으로 사전 집계하세요.",
  };
  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, data: withSource };
  return withSource;
}

export async function readMarketHomeSnapshot(): Promise<MarketHomeResponse | null> {
  const db = getDb();
  if (!db) return null;
  const result = await db.execute({
    sql: `SELECT payload, computed_at, as_of_date
          FROM market_home_snapshots
          WHERE id = 1`,
    args: [],
  });
  const row = result.rows[0];
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(String(row.payload)) as MarketHomeResponse;
    return {
      ...parsed,
      source: "snapshot",
      computedAt: String(row.computed_at ?? parsed.computedAt ?? ""),
      complexKeyVersion:
        parsed.complexKeyVersion ?? MARKET_COMPLEX_KEY_VERSION,
    };
  } catch {
    return null;
  }
}

export async function saveMarketHomeSnapshot(
  data: MarketHomeResponse,
): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  await ensureSchema();
  const computedAt = new Date().toISOString();
  const payload = JSON.stringify({
    ...data,
    source: "snapshot",
    computedAt,
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
  });
  await db.execute({
    sql: `INSERT INTO market_home_snapshots (id, computed_at, as_of_date, payload)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            computed_at = excluded.computed_at,
            as_of_date = excluded.as_of_date,
            payload = excluded.payload`,
    args: [computedAt, data.asOfDate ?? "", payload],
  });
  readCache = null;
}

/** sync/스크립트용 — 시장 홈 스냅샷 재계산·저장 */
export async function rebuildMarketHomeSnapshot(): Promise<MarketHomeResponse> {
  const data = await computeMarketHome();
  await saveMarketHomeSnapshot(data);
  return {
    ...data,
    source: data.source === "empty" ? "empty" : "snapshot",
  };
}

/**
 * 시장 피드 계산 (비동기 배치 전용).
 * 신고가/하락: 동일 단지(apt_name_norm+lawd_cd+dong) + 동일 타입면적,
 * 해당 거래 이전 최고가와 비교 (현재 거래는 prior에 미포함).
 */
export async function computeMarketHome(): Promise<MarketHomeResponse> {
  if (!hasDb()) {
    return emptyResponse("실거래 DB가 연결되지 않았습니다.");
  }

  await ensureSchema();
  const db = getDb();
  if (!db) {
    return emptyResponse("실거래 DB가 연결되지 않았습니다.");
  }

  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS max_d FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  const asOfDate = String(maxRow.rows[0]?.max_d ?? "");
  if (!asOfDate) {
    return emptyResponse("적재된 매매 실거래가 없습니다.");
  }

  const recentTo = asOfDate;
  const recentFrom = addDays(asOfDate, -RECENT_DEAL_DAYS);
  const volumeFrom = addDays(asOfDate, -(VOLUME_WINDOW_DAYS * 2));
  const volumeMid = addDays(asOfDate, -VOLUME_WINDOW_DAYS);

  const [recentResult, volumeRowsResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, lawd_cd, deal_date, apt_name, apt_name_norm, gu, dong,
                   exclusive_area, deal_amount
            FROM transactions
            WHERE deal_type = ?
              AND deal_date >= ?
              AND deal_date <= ?
            ORDER BY deal_date ASC, id ASC`,
      args: ["trade", recentFrom, recentTo],
    }),
    db.execute({
      sql: `SELECT apt_name_norm, apt_name, gu, dong, lawd_cd, deal_date
            FROM transactions
            WHERE deal_type = ?
              AND deal_date >= ?
              AND deal_date <= ?`,
      args: ["trade", volumeFrom, recentTo],
    }),
  ]);

  const recent: RawTrade[] = recentResult.rows.map((row) => ({
    id: String(row.id),
    lawdCd: String(row.lawd_cd),
    dealDate: String(row.deal_date),
    aptName: String(row.apt_name),
    aptNameNorm: String(row.apt_name_norm),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
  }));

  if (recent.length === 0) {
    return {
      ...emptyResponse("최근 계약일 구간에 매매 거래가 없습니다."),
      asOfDate,
      recentFrom,
      recentTo,
    };
  }

  const norms = [...new Set(recent.map((r) => r.aptNameNorm))];
  const priorMax = new Map<string, number>();

  const CHUNK = 250;
  await Promise.all(
    Array.from({ length: Math.ceil(norms.length / CHUNK) }, (_, i) => {
      const slice = norms.slice(i * CHUNK, i * CHUNK + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      return db
        .execute({
          sql: `SELECT apt_name_norm, lawd_cd, dong, exclusive_area,
                       MAX(deal_amount) AS max_amt
                FROM transactions
                WHERE deal_type = ?
                  AND deal_date < ?
                  AND apt_name_norm IN (${placeholders})
                GROUP BY apt_name_norm, lawd_cd, dong, ROUND(exclusive_area * 100)`,
          args: ["trade", recentFrom, ...slice],
        })
        .then((hist) => {
          for (const row of hist.rows) {
            const key = typeKey(
              String(row.apt_name_norm),
              String(row.lawd_cd),
              String(row.dong ?? ""),
              Number(row.exclusive_area) || 0,
            );
            priorMax.set(key, Number(row.max_amt) || 0);
          }
        });
    }),
  );

  const running = new Map<string, number>(priorMax);
  const singoga: MarketDealItem[] = [];
  const drops: MarketDealItem[] = [];

  for (const tx of recent) {
    const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
    const prior = running.get(key) ?? 0;

    if (prior > 0 && tx.dealAmount > prior) {
      const changeAmount = tx.dealAmount - prior;
      const changePct = Math.round((changeAmount / prior) * 1000) / 10;
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
        changePct,
        kind: "singoga",
        kindLabel: "신고가",
      });
    }

    if (prior > 0) {
      const ratio = (tx.dealAmount - prior) / prior;
      if (ratio <= DROP_THRESHOLD) {
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
          changeAmount: tx.dealAmount - prior,
          changePct: Math.round(ratio * 1000) / 10,
          kind: "drop",
          kindLabel: "큰 폭 하락",
        });
      }
    }

    // 동일 일자·복수 건: id 오름차순으로 처리해 이후 건의 prior에 반영
    running.set(key, Math.max(prior, tx.dealAmount));
  }

  singoga.sort((a, b) => (b.changeAmount ?? 0) - (a.changeAmount ?? 0));
  drops.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));

  type VolAgg = {
    aptName: string;
    gu: string;
    dong: string;
    lawdCd: string;
    recentCount: number;
    priorCount: number;
  };
  const volMap = new Map<string, VolAgg>();
  for (const row of volumeRowsResult.rows) {
    const norm = String(row.apt_name_norm);
    const lawdCd = String(row.lawd_cd);
    const dong = String(row.dong ?? "");
    const key = `${norm}|${lawdCd}|${dong}`;
    const dealDate = String(row.deal_date);
    let agg = volMap.get(key);
    if (!agg) {
      agg = {
        aptName: String(row.apt_name),
        gu: String(row.gu ?? ""),
        dong,
        lawdCd,
        recentCount: 0,
        priorCount: 0,
      };
      volMap.set(key, agg);
    }
    if (dealDate >= volumeMid) agg.recentCount += 1;
    else agg.priorCount += 1;
  }

  const volumeSurges: MarketVolumeItem[] = [...volMap.values()]
    .filter(
      (v) =>
        v.recentCount >= MIN_RECENT_VOLUME &&
        v.priorCount >= MIN_PRIOR_VOLUME &&
        v.recentCount / v.priorCount >= MIN_VOLUME_GROWTH_RATIO,
    )
    .map((v) => ({
      aptName: v.aptName,
      gu: v.gu,
      dong: v.dong,
      href: hrefFor({ aptName: v.aptName, lawdCd: v.lawdCd, gu: v.gu }),
      recentCount: v.recentCount,
      priorCount: v.priorCount,
      increaseCount: v.recentCount - v.priorCount,
      growthPct:
        Math.round(((v.recentCount - v.priorCount) / v.priorCount) * 1000) / 10,
    }))
    .sort(
      (a, b) =>
        b.increaseCount - a.increaseCount || b.recentCount - a.recentCount,
    )
    .slice(0, LIST_LIMIT);

  const shownIds = new Set<string>([
    ...singoga.slice(0, LIST_LIMIT).map((i) => i.id),
    ...drops.slice(0, LIST_LIMIT).map((i) => i.id),
  ]);

  const highDeals: MarketDealItem[] = recent
    .filter((tx) => tx.dealAmount >= HIGH_PRICE_MAN && !shownIds.has(tx.id))
    .map((tx) => ({
      id: tx.id,
      aptName: tx.aptName,
      gu: tx.gu,
      dong: tx.dong,
      exclusiveArea: tx.exclusiveArea,
      dealAmount: tx.dealAmount,
      dealDate: tx.dealDate,
      href: hrefFor(tx),
      priorMaxAmount: null,
      changeAmount: null,
      changePct: null,
      kind: "high" as const,
      kindLabel: "고가 거래",
    }))
    .sort((a, b) => b.dealAmount - a.dealAmount);

  // 주요 거래: 신고가/하락 섹션과 중복 최소화, 고가 우선 보강
  const notables: MarketDealItem[] = [
    ...highDeals.slice(0, LIST_LIMIT),
    ...singoga
      .slice(0, LIST_LIMIT)
      .filter((i) => !highDeals.some((h) => h.id === i.id))
      .slice(0, 2),
  ]
    .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
    .sort(
      (a, b) =>
        b.dealDate.localeCompare(a.dealDate) || b.dealAmount - a.dealAmount,
    )
    .slice(0, LIST_LIMIT);

  return {
    source: "db",
    asOfDate,
    recentFrom,
    recentTo,
    dateBasisNote:
      "표시 날짜는 계약일 기준입니다. 국토부 신고·DB 적재 시차로 달력상 ‘오늘’과 다를 수 있습니다.",
    computedAt: new Date().toISOString(),
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    kpis: {
      singogaCount: singoga.length,
      dropCount: drops.length,
      volumeSurgeCount: volumeSurges.length,
      notableCount: notables.length,
    },
    singoga: singoga.slice(0, LIST_LIMIT),
    drops: drops.slice(0, LIST_LIMIT),
    volumeSurges,
    notables,
  };
}
