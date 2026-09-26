/**
 * 지도로 찾기 — 화면 영역(bbox) 안 단지의 좌표 + 최근 12개월 거래 요약 + 단지 속성. 읽기 전용.
 * 좌표: NAVER 중심점(complex_map_anchor) 우선, 없으면 필지 대표점.
 * 가격: transactions (lawd_cd, apt_name_norm, year_month) 인덱스. 매매·전세·월세를 한 번에 읽는다.
 * 추정·보간 없음 — 기간 안 거래가 없으면 가격 없이 보낸다. 전세가율·갭·월세수익률도 같은 면적 범위의
 * 실제 거래 중위값끼리만 계산한다.
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { aptDetailHref } from "@/lib/molit/apt-client";
import { readRankingV4Board } from "@/lib/region-ranking/ranking-v4";
import { regionDongHref } from "@/lib/molit/region-paths";
import { pickLatestDeal } from "@/lib/deals/latest";
import { readMapRecentDeals, type RecentDeal } from "@/lib/map/map-complex-recent";

/** @deprecated 면적 범위(areaMin/areaMax)로 대체 — 옛 URL 호환용 */
export type MapAreaBand = "all" | "small" | "mid" | "large";
export const MAP_AREA_BANDS: Record<MapAreaBand, { label: string; min: number; max: number }> = {
  all: { label: "전체", min: 0, max: 10_000 },
  small: { label: "소형", min: 0, max: 60 },
  mid: { label: "중형", min: 60, max: 85.99 },
  large: { label: "대형", min: 86, max: 10_000 },
};

/** 전용면적 범위 (㎡, 양 끝 포함) */
export type MapAreaRange = { min: number; max: number };
export const MAP_AREA_ANY: MapAreaRange = { min: 0, max: 10_000 };

/** 매매 = trade, 전세 = rent with monthly_rent 0 (보증금만). */
export type MapDealKind = "trade" | "jeonse";
export const MAP_DEAL_KINDS: Record<MapDealKind, string> = { trade: "매매", jeonse: "전세" };

export type MapBBox = { swLat: number; swLng: number; neLat: number; neLng: number };

export type MapComplex = {
  complexId: string;
  aptName: string;
  lat: number;
  lng: number;
  /** 3D 지도 점 자리 — [경도, 위도, 가장 높은 동 높이(m)]: 동 외곽선 가운데 지붕 위 (complex_3d_anchor, 서울). 없으면 lat·lng */
  anchor3d?: [number, number, number] | null;
  dong: string | null;
  householdCount: number | null;
  href: string;
  /**
   * 지도 가격 — 대표 평형(mainAreaSqm, 기간 내 가장 많이 거래된 전용면적)의 가장 최근 실거래가 (만원).
   * 직거래는 빼고(없으면 직거래 포함), 선택한 거래유형(매매·전세) 기준.
   */
  priceMan: number | null;
  /** priceMan 거래의 계약일 */
  priceDate: string | null;
  /** 최근 12개월 대표 평형 거래 범위 (만원) */
  rangeMinMan: number | null;
  rangeMaxMan: number | null;
  /** 대표 평형 이름 "33평" — 단지 상세 평형 선택과 같은 규칙(공급면적 가운데 ÷ 3.3058). 모르면 null */
  pyeongLabel: string | null;
  /** 3.3㎡당 가격 (만원) — 공급 평을 알면 공급 기준, 모르면 전용 기준 */
  perPyeongMan: number | null;
  /** 지도 가격 거래가 신고가·하락(고점 대비 −10% 이하) 기록이면 표시 — 매매만 */
  move: "singoga" | "drop" | null;
  /** 1년 변동 (%) — 대표 평형 최근 6개월 거래 가운데 값 vs 1년 전 같은 6개월(12~18개월 전) 가운데 값. 각 2건 이상일 때만 */
  change1yPct: number | null;
  /** 기간 내 가장 많이 거래된 전용면적(㎡, 소수 첫째 자리) — 마커 표기용 */
  mainAreaSqm: number | null;
  /** 건축년도 (거래 신고의 build_year, 없으면 사용승인일 연도) */
  buildYear: number | null;
  tradeCount12m: number;
  /** 대표 평형 최근 전세가 ÷ 최근 매매가 (%) — 단지 상세와 같은 정의, 둘 다 있을 때만 */
  jeonseRatioPct: number | null;
  /** 대표 평형 최근 매매가 − 최근 전세가 (만원). 음수면 역전(마이너스 갭) */
  gapMan: number | null;
  /** 월세 연 수익률 중위 (%) — 대표 평형 월세×12 ÷ (최근 매매가 − 보증금) */
  rentYieldPct: number | null;
  /** 용적률 (%) */
  farRatio: number | null;
  /** 건폐율 (%) */
  bcrRatio: number | null;
  /** 세대당 주차 대수 */
  parkingPerHousehold: number | null;
  /** 시군구(구) 종합 랭킹 1~3위 — 지역 페이지 '이 지역 아파트 랭킹' 종합과 같은 순위. 그 밖은 null */
  guRank: 1 | 2 | 3 | null;
  /** 시군구 이름 (예: "송파구") */
  guName: string | null;
  /** 지역 상세 링크 — 구(지역 페이지)·동(동 상세) */
  links: MapRegionLinks;
  /** 난방 방식 원문 (개별난방·지역난방·중앙난방…) */
  heatingType: string | null;
};

/**
 * 서울 3D 지도(fields=lite)가 그리는 값만 — 점 색·글자·단지 카드. 전세가율·갭·순위 같은 나머지는 보내지 않는다
 * (화면에 안 쓰는 값은 내려보내지 않기 + 휴대폰 데이터 절약). 조건 칩을 걸면 3D도 전체 값을 받아 2D처럼 거른다.
 */
export const MAP_COMPLEX_LITE_KEYS = [
  "complexId",
  "aptName",
  "lat",
  "lng",
  "dong",
  "householdCount",
  "href",
  "priceMan",
  "priceDate",
  "pyeongLabel",
  // 평형을 모르면 대표 전용㎡ (2D 마커와 같게)
  "mainAreaSqm",
  "perPyeongMan",
  "change1yPct",
  "buildYear",
  // 3D 이름표 값을 2D 마커 표시(전세가율)와 같게
  "jeonseRatioPct",
  "anchor3d",
  // 단지 카드 '더보기' (2D와 같은 값)
  "gapMan",
  "rentYieldPct",
  "rangeMinMan",
  "rangeMaxMan",
  "tradeCount12m",
  // 구 안 순위 왕관 (2D 마커와 같게)
  "guRank",
  "guName",
] as const satisfies ReadonlyArray<keyof MapComplex>;
export type MapComplexLite = Pick<MapComplex, (typeof MAP_COMPLEX_LITE_KEYS)[number]>;

/** 3D 지도용 점 자리 붙이기 — 표가 없거나 읽기 실패면 그대로 (lat·lng로 그린다) */
export async function attach3dAnchors(db: Client, list: MapComplex[]): Promise<MapComplex[]> {
  if (!list.length) return list;
  try {
    const r = await db.execute({
      sql: `SELECT complex_id, lat, lng, top_m FROM complex_3d_anchor WHERE complex_id IN (${list.map(() => "?").join(",")})`,
      args: list.map((c) => c.complexId),
    });
    const by = new Map(r.rows.map((x) => [String(x.complex_id), [Number(x.lng), Number(x.lat), Number(x.top_m)] as [number, number, number]]));
    return list.map((c) => ({ ...c, anchor3d: by.get(c.complexId) ?? null }));
  } catch {
    return list;
  }
}

export function toLiteComplex(c: MapComplex): MapComplexLite {
  const out: Partial<MapComplexLite> = {};
  for (const k of MAP_COMPLEX_LITE_KEYS) (out as Record<string, unknown>)[k] = c[k];
  return out as MapComplexLite;
}

export const MAP_MAX_COMPLEXES = 400;
const WINDOW_MONTHS = 12;
/** 거래 쿼리 한 번에 넣는 단지 이름 수 — 조각을 작게 나눠 콜드 읽기를 병렬로 */
const TX_NAMES_PER_QUERY = 40;
/** 스냅샷·변경 표시 표가 없을 때 스냅샷을 다시 시도하기까지 (그동안 거래 표에서 바로) */
const SNAPSHOT_RETRY_MS = 5 * 60_000;
let recentSnapshotRetryAt = 0;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 대표 평형의 가장 최근 실거래가 — 대표 평형 = 가장 많이 거래된 전용면적(±1㎡).
 * 직거래는 빼고 고른다(대표 평형 거래가 모두 직거래면 그중 최근). 범위는 대표 평형 거래 전체.
 */
function representativePrice(selected: Deal[], kind: "trade" | "jeonse"): {
  priceMan: number | null;
  priceDate: string | null;
  rangeMinMan: number | null;
  rangeMaxMan: number | null;
} {
  const main = modeArea(selected.map((d) => d.area));
  const same = main == null ? [] : selected.filter((d) => Math.abs(d.area - main) < 1);
  if (!same.length) return { priceMan: null, priceDate: null, rangeMinMan: null, rangeMaxMan: null };
  const latest = pickLatestDeal(same, kind, PICK)!;
  const amounts = same.map((d) => d.amount);
  return {
    priceMan: latest.amount,
    priceDate: latest.date,
    rangeMinMan: Math.min(...amounts),
    rangeMaxMan: Math.max(...amounts),
  };
}

/** 가장 많이 거래된 전용면적 (소수 첫째 자리로 묶음). 동률이면 작은 면적. */
function modeArea(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) {
    if (!(v > 0)) continue;
    const k = Math.round(v * 10) / 10;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best != null && k < best)) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function yearMonthMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const PYEONG = 3.3058;

/** 오늘에서 n일 전 (YYYY-MM-DD) — deal_date·seen_date 비교용 */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function regionSlugFor(lawdCd: string): string {
  return LAWD_TO_REGION[lawdCd]?.slug ?? slugFromLawd("", lawdCd);
}

export type MapRegionLinks = {
  lawdCd: string;
  /** 지역 페이지 이름 (시 단위 지역이면 "성남시") */
  guLabel: string;
  guHref: string;
  dongLabel: string | null;
  dongHref: string | null;
};

/** lawd(+동) → 지역 페이지·동 상세 링크. 여러 구를 묶은 시는 동 링크에 구를 붙인다. */
export function mapRegionLinks(lawdCd: string, dong: string | null): MapRegionLinks {
  const reg = LAWD_TO_REGION[lawdCd];
  const slug = regionSlugFor(lawdCd);
  const guName = districtNameFromCode(lawdCd) || reg?.name || lawdCd;
  const multi = (reg?.lawdCodes.length ?? 1) > 1;
  return {
    lawdCd,
    guLabel: reg?.name ?? guName,
    guHref: `/region/${encodeURIComponent(slug)}`,
    dongLabel: dong,
    dongHref: dong ? regionDongHref(slug, dong, multi ? guName : undefined) : null,
  };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * complex_map_anchor (NAVER geocode) exists? Cached per server instance.
 * readMapComplexes 는 이 확인 왕복 없이 anchor 조인을 먼저 시도하고, 표가 없을 때만 필지 좌표로 다시 읽는다.
 */
let anchorTable: boolean | null = null;
export async function hasAnchorTable(db: Client): Promise<boolean> {
  if (anchorTable != null) return anchorTable;
  const r = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name='complex_map_anchor'",
    args: [],
  });
  anchorTable = r.rows.length > 0;
  return anchorTable;
}

type Deal = {
  kind: "trade" | "jeonse" | "wolse";
  amount: number;
  rent: number;
  date: string;
  area: number;
  buildYear: number | null;
  floor: number | null;
  gbn: string | null;
};

const PICK = {
  date: (d: Deal) => d.date,
  floor: (d: Deal) => d.floor,
  amount: (d: Deal) => d.amount,
  gbn: (d: Deal) => d.gbn,
};

/** 영역 안 단지 (좌표·속성) — 세대수 큰 순 최대 MAP_MAX_COMPLEXES+1 */
function readMasterRows(db: Client, bbox: MapBBox, anchored: boolean) {
  const lat = anchored ? "COALESCE(a.lat, m.latitude)" : "m.latitude";
  const lng = anchored ? "COALESCE(a.lng, m.longitude)" : "m.longitude";
  const box = [bbox.swLat, bbox.neLat, bbox.swLng, bbox.neLng];
  // COALESCE 좌표는 인덱스를 못 타 전체 단지(2.7만)를 훑었다. 두 좌표 표를 각각 (lat, lng) 인덱스로
  // 영역 안 후보만 먼저 추린다 — anchor 는 lat·lng NOT NULL 이라 COALESCE 값은 anchor 가 있으면
  // anchor 좌표, 없으면 필지 좌표. 그래서 두 후보의 합집합이 정확히 같은 단지를 담는다(아래 COALESCE 조건은 그대로).
  const candidates = anchored
    ? `AND m.complex_id IN (
             SELECT complex_id FROM complex_map_anchor WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
             UNION
             SELECT complex_id FROM apt_complex_master WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?)`
    : "";
  return db.execute({
    // 영역에 단지가 많으면 세대수 큰 단지부터 (주요 단지가 먼저 보이게).
    sql: `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, m.sigungu,
                 ${lat} AS latitude, ${lng} AS longitude, p.household_count, p.approval_date,
                 p.far_ratio, p.bcr_ratio, p.parking_per_household, p.heating_type
          FROM apt_complex_master m
          ${anchored ? "LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id" : ""}
          LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE ${lat} BETWEEN ? AND ? AND ${lng} BETWEEN ? AND ?
          ${candidates}
          ORDER BY COALESCE(p.household_count, 0) DESC, m.rowid
          LIMIT ?`,
    args: [...box, ...(anchored ? [...box, ...box] : []), MAP_MAX_COMPLEXES + 1],
  });
}

export async function readMapComplexes(
  db: Client,
  bbox: MapBBox,
  area: MapAreaRange,
  deal: MapDealKind = "trade",
  opts: {
    /**
     * 단지별 최근 거래 스냅샷(map_complex_recent) 사용. 기본 "fresh"(변경 번호가 같은 단지만).
     * "off" = 거래 표에서 바로, "ignore-marks" = 저장 내용을 그대로(검증 스크립트 전용).
     */
    snapshot?: "fresh" | "off" | "ignore-marks";
  } = {},
): Promise<{ complexes: MapComplex[]; truncated: boolean }> {
  // 콜드 인스턴스에서 sqlite_master 확인 왕복(약 0.3초)을 앞에 두지 않는다 — anchor 조인을 바로 시도.
  let master;
  if (anchorTable === false) {
    master = await readMasterRows(db, bbox, false);
  } else {
    try {
      master = await readMasterRows(db, bbox, true);
      anchorTable = true;
    } catch (error) {
      if (anchorTable === true || !/no such table/i.test(String(error))) throw error;
      anchorTable = false;
      master = await readMasterRows(db, bbox, false);
    }
  }
  const truncated = master.rows.length > MAP_MAX_COMPLEXES;
  const rows = master.rows.slice(0, MAP_MAX_COMPLEXES);
  if (rows.length === 0) return { complexes: [], truncated: false };

  // 1년 변동을 보려고 18개월을 읽는다 — 나머지 값은 최근 12개월만 쓴다.
  // 12~18개월 전 거래는 선택한 유형(1년 변동 series)만 쓰이므로 다른 유형은 최근 12개월(cut12)만 읽는다.
  const since = yearMonthMonthsAgo(WINDOW_MONTHS + 6);
  const cut12 = daysAgo(365);
  const selectedType = deal === "trade" ? "trade" : "rent";
  const deals = new Map<string, Deal[]>();
  const keyOf = (lawd: unknown, norm: unknown) => `${String(lawd)}|${String(norm)}`;

  // lawd_cd별 `lawd_cd = ? AND apt_name_norm IN (...)` — idx_tx_lawd_apt_ym 를 그대로 탄다.
  // (행 값 IN (VALUES …) 형태는 인덱스를 못 타 30초 넘게 걸렸다.)
  const wanted = new Set(rows.map((r) => keyOf(r.lawd_cd, r.apt_name_norm)));
  const byLawd = new Map<string, string[]>();
  for (const r of rows) {
    const list = byLawd.get(String(r.lawd_cd)) ?? [];
    list.push(String(r.apt_name_norm));
    byLawd.set(String(r.lawd_cd), list);
  }
  const jobs: Array<Promise<void>> = [];
  // 랭킹 보드는 두 번 왕복(발행 포인터 → 후보)이라 가장 먼저 띄운다.
  // 구별 종합 랭킹 상위 3 (발행된 스냅샷 · 30분 캐시). 실패해도 지도는 그대로.
  const guRanks = new Map<string, 1 | 2 | 3>();
  jobs.push(
    Promise.all(
      [...byLawd.keys()].map((lawd) =>
        readRankingV4Board(db, { regionCode: lawd, areaBand: "ALL" }).catch(() => null),
      ),
    ).then((boards) => {
      for (const b of boards) {
        for (const row of b?.rows ?? []) {
          if (row.rank >= 1 && row.rank <= 3) guRanks.set(row.complexId, row.rank as 1 | 2 | 3);
        }
      }
    }),
  );
  const pushDeal = (
    k: string,
    d: { dealType: unknown; amount: number; rent: number; date: string; area: number; buildYear: number; floor: number | null; gbn: string | null },
  ) => {
    if (!wanted.has(k)) return;
    if (!(d.amount > 0)) return;
    const kind = d.dealType === "trade" ? "trade" : d.rent > 0 ? "wolse" : "jeonse";
    const list = deals.get(k) ?? [];
    list.push({
      kind,
      amount: d.amount,
      rent: d.rent,
      date: d.date,
      area: d.area,
      buildYear: Number.isFinite(d.buildYear) && d.buildYear > 1900 ? d.buildYear : null,
      floor: d.floor,
      gbn: d.gbn,
    });
    deals.set(k, list);
  };
  // 거래 표에서 바로 — 스냅샷이 없거나 낡은 단지.
  // 이름은 세대수 큰 순이라 앞에서부터 자르면 첫 조각에 거래가 몰렸다(콜드에서 한 쿼리 9천 행·2초).
  // 조각마다 큰·작은 단지가 섞이도록 번갈아 나눠 조각별 행 수를 고르게 한다 — 단지별 거래는 그대로.
  const readLive = (lawd: string, names: string[]) => {
    const parts = Math.ceil(names.length / TX_NAMES_PER_QUERY);
    const out: Array<Promise<void>> = [];
    for (let p = 0; p < parts; p++) {
      const slice = names.filter((_, j) => j % parts === p);
      out.push(
        db
          .execute({
            sql: `SELECT lawd_cd, apt_name_norm, deal_type, deal_amount, monthly_rent, deal_date,
                         exclusive_area, build_year, dealing_gbn, floor
                  FROM transactions
                  WHERE lawd_cd = ? AND apt_name_norm IN (${slice.map(() => "?").join(",")})
                    AND year_month >= ? AND (deal_type = ? OR deal_date >= ?)
                    AND exclusive_area >= ? AND exclusive_area <= ?`,
            args: [lawd, ...slice, since, selectedType, cut12, area.min, area.max],
          })
          .then((res) => {
            for (const r of res.rows) {
              pushDeal(keyOf(r.lawd_cd, r.apt_name_norm), {
                dealType: r.deal_type,
                amount: Number(r.deal_amount),
                rent: Number(r.monthly_rent) || 0,
                date: String(r.deal_date),
                area: Number(r.exclusive_area),
                buildYear: Number(r.build_year),
                floor: r.floor == null ? null : Number(r.floor),
                gbn: r.dealing_gbn == null ? null : String(r.dealing_gbn),
              });
            }
          }),
      );
    }
    return Promise.all(out).then(() => {});
  };
  const snapshotMode = opts.snapshot ?? "fresh";
  const useSnapshot = snapshotMode === "ignore-marks" || (snapshotMode === "fresh" && Date.now() >= recentSnapshotRetryAt);
  for (const [lawd, all] of byLawd) {
    // 같은 (lawd, 이름) 단지가 둘이면 한 번만 읽는다 — 두 번 읽으면 거래가 겹친다.
    const names = [...new Set(all)];
    if (!useSnapshot) {
      jobs.push(readLive(lawd, names));
      continue;
    }
    // 단지별 최근 거래 스냅샷 (1왕복, PK) — 변경 번호가 같은 단지만. 예전 쿼리와 같은 조건을 여기서 건다.
    // 스냅샷에 없는(낡은·없는) 단지와 읽기 에러는 예전 쿼리. 스냅샷 읽기 에러가 결과에 섞이지 않는다.
    jobs.push(
      readMapRecentDeals(db, lawd, names, since, { ignoreMarks: snapshotMode === "ignore-marks" })
        .catch((error: unknown) => {
          if (snapshotMode === "ignore-marks") throw error;
          // 변경 표시·스냅샷 표가 아직 없으면 잠시 스냅샷을 건너뛴다 (요청마다 실패 왕복을 더하지 않게).
          if (/no such (table|column)/i.test(String(error))) recentSnapshotRetryAt = Date.now() + SNAPSHOT_RETRY_MS;
          else console.error("[map] map_complex_recent read failed — live:", error);
          return new Map<string, RecentDeal[]>();
        })
        .then((snap) => {
          for (const name of names) {
            const list = snap.get(name);
            if (!list) continue;
            const k = keyOf(lawd, name);
            for (const d of list) {
              if (d.yearMonth < since) continue;
              if (!(d.dealType === selectedType || d.date >= cut12)) continue;
              if (!(d.area >= area.min && d.area <= area.max)) continue;
              pushDeal(k, { ...d, buildYear: Number(d.buildYear) });
            }
          }
          const missing = names.filter((n) => !snap.has(n));
          return missing.length ? readLive(lawd, missing) : undefined;
        }),
    );
  }
  // 평형 이름 — 단지 평형 목록(공급 평)에서. 실패해도 지도는 그대로.
  const unitTypes = new Map<string, Array<{ area: number; supplySqm: number | null }>>();
  const ids = rows.map((r) => String(r.complex_id));
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    jobs.push(
      db
        .execute({
          sql: `SELECT complex_id, exclusive_area, supply_pyeong FROM apt_canonical_unit_types
                WHERE complex_id IN (${chunk.map(() => "?").join(",")}) AND supply_pyeong > 0`,
          args: chunk,
        })
        .then((res) => {
          for (const u of res.rows) {
            const k = String(u.complex_id);
            const sp = num(u.supply_pyeong);
            const list = unitTypes.get(k) ?? [];
            // 공급 평이 없는 평형은 쓰이지 않아(아래 supplySqm != null) 쿼리에서 뺀다.
            list.push({ area: Number(u.exclusive_area), supplySqm: sp && sp > 0 ? sp * PYEONG : null });
            unitTypes.set(k, list);
          }
        })
        .catch(() => {}),
    );
  }
  // 신고가·하락 기록 (시장 > 신고가·하락 거래와 같은 표). 매매 지도에서만.
  const moves = new Map<string, "singoga" | "drop">();
  const moveSince = daysAgo(180);
  if (deal === "trade") {
    for (const [lawd, names] of byLawd) {
      jobs.push(
        db
          .execute({
            sql: `SELECT apt_name_norm, deal_date, deal_amount, kind FROM market_price_moves
                  WHERE lawd_cd = ? AND seen_date >= ? AND apt_name_norm IN (${names.map(() => "?").join(",")})`,
            args: [lawd, moveSince, ...names],
          })
          .then((res) => {
            for (const m of res.rows) {
              moves.set(`${lawd}|${m.apt_name_norm}|${m.deal_date}|${Number(m.deal_amount)}`, m.kind === "drop" ? "drop" : "singoga");
            }
          })
          .catch(() => {}),
      );
    }
  }
  await Promise.all(jobs);

  const cut6 = daysAgo(183);
  const pastFrom = daysAgo(548);

  const complexes: MapComplex[] = rows.map((r) => {
    const lawd = String(r.lawd_cd);
    const all18 = deals.get(keyOf(r.lawd_cd, r.apt_name_norm)) ?? [];
    const all = all18.filter((d) => d.date >= cut12);
    const trades = all.filter((d) => d.kind === "trade");
    const jeonses = all.filter((d) => d.kind === "jeonse");
    const wolses = all.filter((d) => d.kind === "wolse");
    const selected = deal === "trade" ? trades : jeonses;
    // 전세가율·갭·월세수익률 — 단지 상세와 같은 정의: 매매 대표 평형(±1㎡)의 최근 매매가·최근 전세가
    const tradeMain = modeArea(trades.map((d) => d.area));
    const inMain = (d: Deal) => tradeMain != null && Math.abs(d.area - tradeMain) < 1;
    const tradeNow = pickLatestDeal(trades.filter(inMain), "trade", PICK)?.amount ?? null;
    const jeonseNow = pickLatestDeal(jeonses.filter(inMain), "jeonse", PICK)?.amount ?? null;
    const yields = tradeNow
      ? wolses
          .filter((d) => inMain(d) && tradeNow > d.amount)
          .map((d) => ((d.rent * 12) / (tradeNow - d.amount)) * 100)
      : [];
    // 대표 평형 · 평 · 평당가 · 1년 변동 · 신고가/하락 · 오래된 가격
    const rp = representativePrice(selected, deal);
    const main = modeArea(selected.map((d) => d.area));
    const supplies = (unitTypes.get(String(r.complex_id)) ?? [])
      .filter((u) => main != null && Math.abs(u.area - main) < 1 && u.supplySqm != null)
      .map((u) => u.supplySqm!);
    const pyeong = supplies.length ? Math.round((Math.min(...supplies) + Math.max(...supplies)) / 2 / PYEONG) : null;
    const perPyeongMan =
      rp.priceMan != null && main != null ? Math.round(rp.priceMan / (pyeong ?? main / PYEONG)) : null;
    const series = all18.filter((d) => d.kind === deal && main != null && Math.abs(d.area - main) < 1);
    const recent = series.filter((d) => d.date >= cut6).map((d) => d.amount);
    const yearAgo = series.filter((d) => d.date >= pastFrom && d.date < cut12).map((d) => d.amount);
    const change1yPct =
      recent.length >= 2 && yearAgo.length >= 2
        ? Math.round((median(recent)! / median(yearAgo)! - 1) * 1000) / 10
        : null;
    const gu = (r.sigungu ? String(r.sigungu).split(/\s+/).pop() : null) || districtNameFromCode(lawd);
    const approvalYear = r.approval_date ? Number(String(r.approval_date).slice(0, 4)) || null : null;
    return {
      complexId: String(r.complex_id),
      aptName: String(r.apt_name),
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      dong: r.legal_dong_name ? String(r.legal_dong_name) : null,
      householdCount: num(r.household_count),
      href: aptDetailHref(String(r.apt_name), regionSlugFor(lawd), gu || undefined),
      ...rp,
      pyeongLabel: pyeong ? `${pyeong}평` : null,
      perPyeongMan,
      move: rp.priceMan != null ? (moves.get(`${lawd}|${r.apt_name_norm}|${rp.priceDate}|${rp.priceMan}`) ?? null) : null,
      change1yPct,
      mainAreaSqm: main,
      buildYear: all.find((d) => d.buildYear != null)?.buildYear ?? approvalYear,
      tradeCount12m: selected.length,
      jeonseRatioPct: tradeNow && jeonseNow ? Math.round((jeonseNow / tradeNow) * 1000) / 10 : null,
      gapMan: tradeNow != null && jeonseNow != null ? Math.round(tradeNow - jeonseNow) : null,
      rentYieldPct: yields.length ? Math.round(median(yields)! * 100) / 100 : null,
      farRatio: num(r.far_ratio),
      bcrRatio: num(r.bcr_ratio),
      parkingPerHousehold: num(r.parking_per_household),
      heatingType: r.heating_type ? String(r.heating_type) : null,
      guRank: guRanks.get(String(r.complex_id)) ?? null,
      guName: gu || null,
      links: mapRegionLinks(lawd, r.legal_dong_name ? String(r.legal_dong_name) : null),
    };
  });

  return { complexes, truncated };
}

/** URL → 전용면적 범위. areaMin/areaMax(㎡) 우선, 없으면 옛 band. */
export function parseAreaRange(sp: URLSearchParams): MapAreaRange {
  const min = Number(sp.get("areaMin"));
  const max = Number(sp.get("areaMax"));
  if (sp.has("areaMin") || sp.has("areaMax")) {
    return {
      min: Number.isFinite(min) && min > 0 ? min : 0,
      max: Number.isFinite(max) && max > 0 ? max : MAP_AREA_ANY.max,
    };
  }
  const band = sp.get("band");
  if (band && band in MAP_AREA_BANDS) {
    const b = MAP_AREA_BANDS[band as MapAreaBand];
    return { min: b.min, max: b.max };
  }
  return MAP_AREA_ANY;
}
