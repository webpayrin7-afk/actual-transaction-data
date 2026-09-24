/**
 * 청약홈 사본(applyhome_*) 읽기 — 분양 메뉴(청약 일정 · 최근 경쟁률 · 입주 예정 · 지난 청약 결과 · 공고 상세).
 * 읽기 전용. 값은 원천 그대로(분양가 = 주택형별 최고 분양가, 만원). 경쟁률 = 1순위 접수 ÷ 일반공급 세대.
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { METRO_LABELS, metroFromLawdNationwide, slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { addDays } from "@/lib/market/keys";
import { seoulToday } from "@/lib/market/time";

export type ApplyhomeNotice = {
  id: string;
  name: string;
  place: string;
  /** 시·도 키 (seoul, gyeonggi …). 주소로 못 찾으면 청약 지역명으로 */
  metro: string;
  kind: string | null;
  totalSupply: number | null;
  specialBegin: string | null;
  rceptBegin: string | null;
  rceptEnd: string | null;
  winnerDate: string | null;
  moveInYm: string | null;
  priceMin: number | null;
  priceMax: number | null;
  url: string | null;
};

export type ApplyhomeCompetition = ApplyhomeNotice & {
  generalSupply: number;
  firstRankRequests: number;
  /** 1순위 경쟁률 (배) */
  rate: number;
};

export type MoveInRegion = {
  slug: string;
  name: string;
  households: number;
  projects: number;
  firstYm: string;
  lastYm: string;
};

export type ApplyhomeOverview = {
  today: string;
  upcoming: ApplyhomeNotice[];
  /** 최근 30일 접수 마감, 경쟁률 높은 순 */
  competition: ApplyhomeCompetition[];
  /** 최근 12개월 접수 마감, 최신순 (경쟁률 없는 공고 포함 — rate 0) */
  history: ApplyhomeCompetition[];
  moveIn: { fromYm: string; toYm: string; byMetro: Record<string, MoveInRegion[]> };
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { at: number; key: string; value: ApplyhomeOverview } | null = null;

const METRO_BY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(METRO_LABELS).map(([k, v]) => [v, k]),
);

function metroOf(lawd: string | null, area: string | null): string {
  if (lawd) return LAWD_TO_REGION[lawd]?.metro ?? metroFromLawdNationwide(lawd);
  return (area && METRO_BY_LABEL[area]) || "other";
}

function placeOf(lawd: string | null, area: string | null): string {
  if (!lawd) return area ?? "";
  const reg = LAWD_TO_REGION[lawd];
  const district = districtNameFromCode(lawd);
  const name = !reg
    ? district
    : reg.districts.length === 1
      ? reg.name
      : district.startsWith(reg.name)
        ? district
        : `${reg.name} ${district}`;
  return [area, name].filter(Boolean).join(" ");
}

function ymOf(date: string, addMonths: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + addMonths;
  return `${y + Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, "0")}`;
}

type DbRow = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function toNotice(r: DbRow): ApplyhomeNotice {
  const lawd = str(r.lawd_cd);
  const area = str(r.area_name);
  return {
    id: String(r.house_manage_no),
    name: String(r.house_nm),
    place: placeOf(lawd, area),
    metro: metroOf(lawd, area),
    kind:
      [str(r.house_secd_nm) === "APT" ? null : str(r.house_secd_nm), str(r.house_dtl_secd_nm)]
        .filter(Boolean)
        .join(" · ") || null,
    totalSupply: num(r.total_supply),
    specialBegin: str(r.special_rcept_begin),
    rceptBegin: str(r.rcept_begin),
    rceptEnd: str(r.rcept_end),
    winnerDate: str(r.winner_date),
    moveInYm: str(r.move_in_ym),
    priceMin: num(r.price_min),
    priceMax: num(r.price_max),
    url: str(r.notice_url),
  };
}

const NOTICE_COLS = `n.house_manage_no, n.house_nm, n.lawd_cd, n.area_name, n.house_secd_nm, n.house_dtl_secd_nm,
  n.total_supply, n.special_rcept_begin, n.rcept_begin, n.rcept_end, n.winner_date, n.move_in_ym, n.notice_url,
  (SELECT MIN(top_amount) FROM applyhome_models m WHERE m.house_manage_no = n.house_manage_no AND top_amount > 0) AS price_min,
  (SELECT MAX(top_amount) FROM applyhome_models m WHERE m.house_manage_no = n.house_manage_no AND top_amount > 0) AS price_max`;

const RATE_COLS = `(SELECT SUM(general_supply) FROM applyhome_models m WHERE m.house_manage_no = n.house_manage_no) AS general_supply,
  (SELECT SUM(request_count) FROM applyhome_competition c
    WHERE c.house_manage_no = n.house_manage_no AND c.rank_code = 1) AS first_rank_requests`;

function withRate(r: DbRow): ApplyhomeCompetition {
  const g = Number(r.general_supply ?? 0);
  const q = Number(r.first_rank_requests ?? 0);
  return {
    ...toNotice(r),
    generalSupply: g,
    firstRankRequests: q,
    rate: g > 0 ? Math.round((q / g) * 10) / 10 : 0,
  };
}

export async function readApplyhomeOverview(db: Client): Promise<ApplyhomeOverview> {
  const today = seoulToday();
  if (cache && cache.key === today && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const fromYm = ymOf(today, 1);
  const toYm = ymOf(today, 24);
  const [upcomingRes, historyRes, moveRes] = await Promise.all([
    // 접수가 끝나지 않은 공고 (특별공급 시작일 → 1순위 시작일 순)
    db.execute({
      sql: `SELECT ${NOTICE_COLS} FROM applyhome_notices n
            WHERE n.rcept_end >= ?
            ORDER BY COALESCE(n.special_rcept_begin, n.rcept_begin), n.rcept_begin`,
      args: [today],
    }),
    // 최근 12개월 접수가 끝난 공고 + 1순위 경쟁률
    db.execute({
      sql: `SELECT ${NOTICE_COLS}, ${RATE_COLS}
            FROM applyhome_notices n
            WHERE n.rcept_end >= ? AND n.rcept_end < ?
            ORDER BY n.rcept_end DESC, n.house_manage_no DESC`,
      args: [addDays(today, -365), today],
    }),
    // 앞으로 24개월 입주 예정 (공급 세대 기준, 임대 제외)
    db.execute({
      sql: `SELECT lawd_cd, move_in_ym, total_supply FROM applyhome_notices
            WHERE lawd_cd IS NOT NULL AND move_in_ym BETWEEN ? AND ? AND total_supply > 0
              AND COALESCE(rent_secd_nm, '') <> '임대주택'`,
      args: [fromYm, toYm],
    }),
  ]);

  const upcoming = upcomingRes.rows.map((r) => toNotice(r as DbRow));
  const history = historyRes.rows.map((r) => withRate(r as DbRow));
  const since30 = addDays(today, -30);
  const competition = history
    .filter((x) => (x.rceptEnd ?? "") >= since30 && x.generalSupply >= 10 && x.firstRankRequests > 0)
    .sort((a, b) => b.rate - a.rate);

  const agg = new Map<string, MoveInRegion & { metro: string }>();
  for (const r of moveRes.rows) {
    const lawd = String(r.lawd_cd);
    const reg = LAWD_TO_REGION[lawd];
    const slug = reg?.slug ?? slugFromLawd("", lawd);
    const ym = String(r.move_in_ym);
    const e = agg.get(slug) ?? {
      slug,
      name: reg?.name ?? districtNameFromCode(lawd),
      metro: reg?.metro ?? metroFromLawdNationwide(lawd),
      households: 0,
      projects: 0,
      firstYm: ym,
      lastYm: ym,
    };
    e.households += Number(r.total_supply);
    e.projects += 1;
    if (ym < e.firstYm) e.firstYm = ym;
    if (ym > e.lastYm) e.lastYm = ym;
    agg.set(slug, e);
  }
  const byMetro: Record<string, MoveInRegion[]> = {};
  for (const { metro, ...e } of agg.values()) (byMetro[metro] ??= []).push(e);
  for (const list of Object.values(byMetro)) list.sort((a, b) => b.households - a.households);

  const value = { today, upcoming, competition, history, moveIn: { fromYm, toYm, byMetro } };
  cache = { at: Date.now(), key: today, value };
  return value;
}

/* ───────────── 공고 상세 ───────────── */

export type ApplyhomeModel = {
  modelNo: string;
  /** 전용면적 (㎡) — 주택형 앞자리 */
  exclusiveArea: number | null;
  /** 주택형 표기 (예: "84A") */
  typeLabel: string;
  supplyArea: number | null;
  generalSupply: number;
  specialSupply: number;
  topAmount: number | null;
  /** 1순위 (해당지역 · 기타지역) */
  firstRank: { local: number; other: number; supply: number; rate: number | null };
};

export type NearbyPrice = {
  /** "dong" = 같은 법정동, "gu" = 같은 시·군·구 */
  scope: "dong" | "gu";
  scopeName: string;
  /** 비교 전용면적 구간 (㎡) */
  areaFrom: number;
  areaTo: number;
  /** 10년 이내 준공만 모았는지 */
  newOnly: boolean;
  count: number;
  median: number;
  /** 이 주택형 최고 분양가 ÷ 주변 중위 − 1 (%) */
  diffPct: number | null;
};

export type ApplyhomeDetail = {
  notice: ApplyhomeNotice & {
    address: string | null;
    builder: string | null;
    developer: string | null;
    contractBegin: string | null;
    contractEnd: string | null;
    noticeDate: string | null;
    homepage: string | null;
    regionHref: string | null;
  };
  models: Array<ApplyhomeModel & { nearby: NearbyPrice | null }>;
  totals: { generalSupply: number; specialSupply: number; firstRankRequests: number; rate: number | null };
};

/** 주택형 "084.9458A" → 84.9458 · "84A" */
function parseHouseTy(ty: string | null): { area: number | null; label: string } {
  const m = ty ? /^0*(\d+)(?:\.(\d+))?([A-Z]*)/.exec(ty.trim()) : null;
  if (!m) return { area: null, label: ty ?? "" };
  const area = Number(`${m[1]}.${m[2] ?? "0"}`);
  return { area: Number.isFinite(area) ? area : null, label: `${m[1]}${m[3] ?? ""}` };
}

/** 주소에서 그 시·군·구의 법정동 이름 찾기 (정확 일치) */
async function dongFromAddress(db: Client, lawd: string, address: string | null): Promise<string | null> {
  if (!address) return null;
  const tokens = address.replace(/[(),]/g, " ").split(/\s+/).filter((t) => /(동|가|읍|면)$/.test(t));
  if (!tokens.length) return null;
  const res = await db.execute({
    sql: `SELECT DISTINCT legal_dong_name FROM apt_complex_master
          WHERE lawd_cd = ? AND legal_dong_name IN (${tokens.map(() => "?").join(",")})`,
    args: [lawd, ...tokens],
  });
  return res.rows.length === 1 ? String(res.rows[0]!.legal_dong_name) : null;
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const NEARBY_MIN = 5;
const AREA_TOL = 3;

export async function readApplyhomeDetail(db: Client, id: string): Promise<ApplyhomeDetail | null> {
  const [nRes, mRes, cRes] = await Promise.all([
    db.execute({
      sql: `SELECT ${NOTICE_COLS}, n.address, n.builder, n.developer, n.contract_begin, n.contract_end,
                   n.notice_date, n.homepage
            FROM applyhome_notices n WHERE n.house_manage_no = ?`,
      args: [id],
    }),
    db.execute({
      sql: `SELECT model_no, house_ty, supply_area, general_supply, special_supply, top_amount
            FROM applyhome_models WHERE house_manage_no = ? ORDER BY model_no`,
      args: [id],
    }),
    db.execute({
      sql: `SELECT model_no, reside_code, supply_count, request_count
            FROM applyhome_competition WHERE house_manage_no = ? AND rank_code = 1`,
      args: [id],
    }),
  ]);
  const row = nRes.rows[0] as DbRow | undefined;
  if (!row) return null;
  const base = toNotice(row);
  const lawd = str(row.lawd_cd);
  const address = str(row.address);
  const reg = lawd ? LAWD_TO_REGION[lawd] : null;

  const first = new Map<string, { local: number; other: number; supply: number }>();
  for (const r of cRes.rows) {
    const k = String(r.model_no);
    const e = first.get(k) ?? { local: 0, other: 0, supply: 0 };
    if (String(r.reside_code) === "01") e.local += Number(r.request_count ?? 0);
    else e.other += Number(r.request_count ?? 0);
    e.supply = Math.max(e.supply, Number(r.supply_count ?? 0));
    first.set(k, e);
  }

  const models: ApplyhomeModel[] = mRes.rows.map((r) => {
    const { area, label } = parseHouseTy(str(r.house_ty));
    const f = first.get(String(r.model_no));
    const supply = f?.supply || Number(r.general_supply ?? 0);
    const req = f ? f.local + f.other : 0;
    return {
      modelNo: String(r.model_no),
      exclusiveArea: area,
      typeLabel: label,
      supplyArea: num(r.supply_area),
      generalSupply: Number(r.general_supply ?? 0),
      specialSupply: Number(r.special_supply ?? 0),
      topAmount: num(r.top_amount) || null,
      firstRank: {
        local: f?.local ?? 0,
        other: f?.other ?? 0,
        supply,
        rate: f && supply > 0 ? Math.round((req / supply) * 100) / 100 : null,
      },
    };
  });

  // 주변 시세: 같은 법정동(없으면 같은 시·군·구) · 전용 ±3㎡ · 최근 12개월 매매. 10년 이내 준공이 5건 이상이면 그것만.
  const dong = lawd ? await dongFromAddress(db, lawd, address) : null;
  const since = ymOf(seoulToday(), -12);
  const newYear = Number(seoulToday().slice(0, 4)) - 10;
  const areaKeys = [...new Set(models.map((m) => (m.exclusiveArea != null ? Math.round(m.exclusiveArea) : null)))].filter(
    (x): x is number => x != null,
  );
  const nearbyByArea = new Map<number, NearbyPrice | null>();
  if (lawd && areaKeys.length) {
    const lo = Math.min(...areaKeys) - AREA_TOL;
    const hi = Math.max(...areaKeys) + AREA_TOL;
    const tx = await db.execute({
      sql: `SELECT dong, exclusive_area, deal_amount, build_year FROM transactions
            WHERE lawd_cd = ? AND year_month >= ? AND deal_type = 'trade'
              AND exclusive_area BETWEEN ? AND ? AND deal_amount > 0`,
      args: [lawd, since, lo, hi],
    });
    const rows = tx.rows.map((r) => ({
      dong: String(r.dong ?? ""),
      area: Number(r.exclusive_area),
      amount: Number(r.deal_amount),
      year: Number(r.build_year) || 0,
    }));
    const guName = districtNameFromCode(lawd);
    for (const a of areaKeys) {
      const inArea = rows.filter((r) => Math.abs(r.area - a) <= AREA_TOL);
      const pick = (list: typeof rows) => {
        const fresh = list.filter((r) => r.year >= newYear);
        return fresh.length >= NEARBY_MIN ? { list: fresh, newOnly: true } : { list, newOnly: false };
      };
      const tries: Array<{ scope: "dong" | "gu"; name: string; list: typeof rows }> = [];
      if (dong) tries.push({ scope: "dong", name: dong, list: inArea.filter((r) => r.dong === dong) });
      tries.push({ scope: "gu", name: guName, list: inArea });
      let found: NearbyPrice | null = null;
      for (const t of tries) {
        const p = pick(t.list);
        if (p.list.length < NEARBY_MIN) continue;
        found = {
          scope: t.scope,
          scopeName: t.name,
          areaFrom: a - AREA_TOL,
          areaTo: a + AREA_TOL,
          newOnly: p.newOnly,
          count: p.list.length,
          median: Math.round(medianOf(p.list.map((r) => r.amount))!),
          diffPct: null,
        };
        break;
      }
      nearbyByArea.set(a, found);
    }
  }

  const withNearby = models.map((m) => {
    const nb = m.exclusiveArea != null ? nearbyByArea.get(Math.round(m.exclusiveArea)) ?? null : null;
    return {
      ...m,
      nearby:
        nb && m.topAmount
          ? { ...nb, diffPct: Math.round(((m.topAmount - nb.median) / nb.median) * 1000) / 10 }
          : nb,
    };
  });

  const totals = models.reduce(
    (t, m) => ({
      generalSupply: t.generalSupply + m.generalSupply,
      specialSupply: t.specialSupply + m.specialSupply,
      firstRankRequests: t.firstRankRequests + m.firstRank.local + m.firstRank.other,
    }),
    { generalSupply: 0, specialSupply: 0, firstRankRequests: 0 },
  );

  return {
    notice: {
      ...base,
      address,
      builder: str(row.builder),
      developer: str(row.developer),
      contractBegin: str(row.contract_begin),
      contractEnd: str(row.contract_end),
      noticeDate: str(row.notice_date),
      homepage: str(row.homepage),
      regionHref: lawd ? `/region/${reg?.slug ?? slugFromLawd("", lawd)}` : null,
    },
    models: withNearby,
    totals: {
      ...totals,
      rate:
        totals.generalSupply > 0 && totals.firstRankRequests > 0
          ? Math.round((totals.firstRankRequests / totals.generalSupply) * 10) / 10
          : null,
    },
  };
}

/* ───────────── 분양 결과 (주택형 단위) ───────────── */

export type ResultOutcome = "local1" | "rank1" | "rank2" | "short" | "none";

export const OUTCOME_LABELS: Record<ResultOutcome, string> = {
  local1: "1순위 해당지역 마감",
  rank1: "1순위 마감",
  rank2: "2순위 마감",
  short: "청약 미달",
  none: "접수 기록 없음",
};

export type ApplyhomeResult = {
  noticeId: string;
  modelNo: string;
  name: string;
  typeLabel: string;
  exclusiveArea: number | null;
  place: string;
  metro: string;
  /** 공공(국민) 여부 */
  isPublic: boolean;
  rceptEnd: string | null;
  topAmount: number | null;
  supply: number;
  firstRankRequests: number;
  /** 1순위 경쟁률 (배) — 1순위 접수 ÷ 일반공급 */
  rate: number | null;
  outcome: ResultOutcome;
};

export type ResultsQuery = {
  metro: string;
  supplier: "all" | "private" | "public";
  area: "all" | "s" | "m" | "l";
  price: "all" | "p1" | "p2" | "p3" | "p4";
  page: number;
};

export const RESULTS_PAGE_SIZE = 15;

let resultsCache: { at: number; key: string; rows: ApplyhomeResult[] } | null = null;

async function allResults(db: Client): Promise<ApplyhomeResult[]> {
  const today = seoulToday();
  if (resultsCache && resultsCache.key === today && Date.now() - resultsCache.at < CACHE_TTL_MS) {
    return resultsCache.rows;
  }
  const res = await db.execute({
    sql: `SELECT n.house_manage_no, n.house_nm, n.lawd_cd, n.area_name, n.house_dtl_secd_nm, n.rcept_end,
                 m.model_no, m.house_ty, m.general_supply, m.top_amount,
                 (SELECT SUM(CASE WHEN c.rank_code = 1 AND c.reside_code = '01' THEN c.request_count ELSE 0 END)
                    FROM applyhome_competition c WHERE c.house_manage_no = m.house_manage_no AND c.model_no = m.model_no) AS local1,
                 (SELECT SUM(CASE WHEN c.rank_code = 1 THEN c.request_count ELSE 0 END)
                    FROM applyhome_competition c WHERE c.house_manage_no = m.house_manage_no AND c.model_no = m.model_no) AS total1,
                 (SELECT SUM(CASE WHEN c.rank_code = 2 THEN c.request_count ELSE 0 END)
                    FROM applyhome_competition c WHERE c.house_manage_no = m.house_manage_no AND c.model_no = m.model_no) AS total2,
                 (SELECT MAX(c.supply_count)
                    FROM applyhome_competition c WHERE c.house_manage_no = m.house_manage_no AND c.model_no = m.model_no) AS comp_supply,
                 (SELECT COUNT(*)
                    FROM applyhome_competition c WHERE c.house_manage_no = m.house_manage_no AND c.model_no = m.model_no) AS comp_rows
          FROM applyhome_models m
          JOIN applyhome_notices n ON n.house_manage_no = m.house_manage_no
          WHERE n.rcept_end >= ? AND n.rcept_end < ?
          ORDER BY n.rcept_end DESC, n.house_manage_no DESC, m.model_no`,
    args: [addDays(today, -365), today],
  });
  const rows = res.rows.map((r) => {
    const { area, label } = parseHouseTy(str(r.house_ty));
    const supply = Number(r.comp_supply ?? 0) || Number(r.general_supply ?? 0);
    const local1 = Number(r.local1 ?? 0);
    const total1 = Number(r.total1 ?? 0);
    const total2 = Number(r.total2 ?? 0);
    const outcome: ResultOutcome =
      Number(r.comp_rows ?? 0) === 0 || supply === 0
        ? "none"
        : local1 >= supply
          ? "local1"
          : total1 >= supply
            ? "rank1"
            : total1 + total2 >= supply
              ? "rank2"
              : "short";
    const lawd = str(r.lawd_cd);
    const areaName = str(r.area_name);
    return {
      noticeId: String(r.house_manage_no),
      modelNo: String(r.model_no),
      name: String(r.house_nm),
      typeLabel: label,
      exclusiveArea: area,
      place: placeOf(lawd, areaName),
      metro: metroOf(lawd, areaName),
      isPublic: str(r.house_dtl_secd_nm) === "국민",
      rceptEnd: str(r.rcept_end),
      topAmount: num(r.top_amount) || null,
      supply,
      firstRankRequests: total1,
      rate: supply > 0 && outcome !== "none" ? Math.round((total1 / supply) * 100) / 100 : null,
      outcome,
    };
  });
  resultsCache = { at: Date.now(), key: today, rows };
  return rows;
}

const AREA_BANDS: Record<ResultsQuery["area"], [number, number]> = {
  all: [0, Infinity],
  s: [0, 60],
  m: [60, 85.0001],
  l: [85.0001, Infinity],
};
const PRICE_BANDS: Record<ResultsQuery["price"], [number, number]> = {
  all: [0, Infinity],
  p1: [0, 50_000],
  p2: [50_000, 90_000],
  p3: [90_000, 150_000],
  p4: [150_000, Infinity],
};

export async function readApplyhomeResults(
  db: Client,
  q: ResultsQuery,
): Promise<{ total: number; page: number; pageSize: number; items: ApplyhomeResult[]; counts: Record<ResultOutcome, number> }> {
  const [aLo, aHi] = AREA_BANDS[q.area];
  const [pLo, pHi] = PRICE_BANDS[q.price];
  const filtered = (await allResults(db)).filter(
    (r) =>
      (q.metro === "all" || r.metro === q.metro) &&
      (q.supplier === "all" || (q.supplier === "public") === r.isPublic) &&
      (q.area === "all" || (r.exclusiveArea != null && r.exclusiveArea >= aLo && r.exclusiveArea < aHi)) &&
      (q.price === "all" || (r.topAmount != null && r.topAmount >= pLo && r.topAmount < pHi)),
  );
  const counts = { local1: 0, rank1: 0, rank2: 0, short: 0, none: 0 } as Record<ResultOutcome, number>;
  for (const r of filtered) counts[r.outcome]++;
  const page = Math.max(1, q.page);
  return {
    total: filtered.length,
    page,
    pageSize: RESULTS_PAGE_SIZE,
    items: filtered.slice((page - 1) * RESULTS_PAGE_SIZE, page * RESULTS_PAGE_SIZE),
    counts,
  };
}
