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
  /** 최근 12개월 선택 면적·거래유형 중위가 (만원) — 전세가율·갭 계산용 */
  medianPriceMan: number | null;
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
  latestDealDate: string | null;
  latestPriceMan: number | null;
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

export const MAP_MAX_COMPLEXES = 400;
const WINDOW_MONTHS = 12;

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

/** complex_map_anchor (NAVER geocode) exists? Cached per server instance. */
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

export async function readMapComplexes(
  db: Client,
  bbox: MapBBox,
  area: MapAreaRange,
  deal: MapDealKind = "trade",
): Promise<{ complexes: MapComplex[]; truncated: boolean }> {
  const anchored = await hasAnchorTable(db);
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
  const master = await db.execute({
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
  for (const [lawd, names] of byLawd) {
    for (let i = 0; i < names.length; i += 80) {
      const slice = names.slice(i, i + 80);
      jobs.push(
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
              const k = keyOf(r.lawd_cd, r.apt_name_norm);
              if (!wanted.has(k)) continue;
              const amount = Number(r.deal_amount);
              if (!(amount > 0)) continue;
              const rent = Number(r.monthly_rent) || 0;
              const kind = r.deal_type === "trade" ? "trade" : rent > 0 ? "wolse" : "jeonse";
              const by = Number(r.build_year);
              const list = deals.get(k) ?? [];
              list.push({
                kind,
                amount,
                rent,
                date: String(r.deal_date),
                area: Number(r.exclusive_area),
                buildYear: Number.isFinite(by) && by > 1900 ? by : null,
                floor: r.floor == null ? null : Number(r.floor),
                gbn: r.dealing_gbn == null ? null : String(r.dealing_gbn),
              });
              deals.set(k, list);
            }
          }),
      );
    }
  }
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
  // 평형 이름 — 단지 평형 목록(공급 평)에서. 실패해도 지도는 그대로.
  const unitTypes = new Map<string, Array<{ area: number; supplySqm: number | null }>>();
  const ids = rows.map((r) => String(r.complex_id));
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    jobs.push(
      db
        .execute({
          sql: `SELECT complex_id, exclusive_area, supply_pyeong FROM apt_canonical_unit_types
                WHERE complex_id IN (${chunk.map(() => "?").join(",")})`,
          args: chunk,
        })
        .then((res) => {
          for (const u of res.rows) {
            const k = String(u.complex_id);
            const sp = num(u.supply_pyeong);
            const list = unitTypes.get(k) ?? [];
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
    const latest = selected.reduce<Deal | null>((acc, d) => (!acc || d.date > acc.date ? d : acc), null);
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
      medianPriceMan: median(selected.map((d) => d.amount)),
      pyeongLabel: pyeong ? `${pyeong}평` : null,
      perPyeongMan,
      move: rp.priceMan != null ? (moves.get(`${lawd}|${r.apt_name_norm}|${rp.priceDate}|${rp.priceMan}`) ?? null) : null,
      change1yPct,
      mainAreaSqm: main,
      buildYear: all.find((d) => d.buildYear != null)?.buildYear ?? approvalYear,
      tradeCount12m: selected.length,
      latestDealDate: latest?.date ?? null,
      latestPriceMan: latest?.amount ?? null,
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
