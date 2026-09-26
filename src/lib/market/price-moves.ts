/**
 * 신고가 · 하락 거래 페이지 읽기 — market_price_moves (scripts/build-price-moves.ts 가 만든 기록).
 * 목록은 같은 단지를 한 줄로 묶는다(대표 = 변화가 가장 큰 거래, "외 N건").
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode, getRegion } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { hasDiscoveryAtColumn } from "@/lib/db/discovery-axis";
import { addDays } from "@/lib/market/keys";
import { seoulDayBoundsUtc, seoulToday } from "@/lib/market/time";
import { aptDetailHref } from "@/lib/molit/apt-client";
import type { PriceMoveKind } from "@/lib/market/price-moves-build";

export type PriceMovesPeriod = "1d" | "7d" | "30d";
export const PRICE_MOVES_PERIODS: Record<PriceMovesPeriod, { label: string; days: number }> = {
  "1d": { label: "최근 확인일", days: 1 },
  "7d": { label: "최근 7일", days: 7 },
  "30d": { label: "최근 30일", days: 30 },
};

export type PriceMovesSort = "amount" | "pct" | "recent";
export type PriceMovesArea = "all" | "small" | "mid" | "large";
const AREA: Record<PriceMovesArea, [number, number]> = {
  all: [0, 10_000],
  small: [0, 59.99],
  mid: [60, 85.99],
  large: [86, 10_000],
};

/** 시도 선택 — lawd_cd 앞 두 자리 (개편된 새 코드 포함) */
export const PRICE_MOVES_SIDO: Array<{ id: string; label: string; prefixes: string[] }> = [
  { id: "seoul", label: "서울", prefixes: ["11"] },
  { id: "gyeonggi", label: "경기", prefixes: ["41"] },
  { id: "incheon", label: "인천", prefixes: ["28"] },
  { id: "busan", label: "부산", prefixes: ["26"] },
  { id: "daegu", label: "대구", prefixes: ["27"] },
  { id: "gwangju-jeonnam", label: "광주·전남", prefixes: ["29", "46", "12"] },
  { id: "daejeon", label: "대전", prefixes: ["30"] },
  { id: "ulsan", label: "울산", prefixes: ["31"] },
  { id: "sejong", label: "세종", prefixes: ["36"] },
  { id: "gangwon", label: "강원", prefixes: ["42", "51"] },
  { id: "chungbuk", label: "충북", prefixes: ["43"] },
  { id: "chungnam", label: "충남", prefixes: ["44"] },
  { id: "jeonbuk", label: "전북", prefixes: ["45", "52"] },
  { id: "gyeongbuk", label: "경북", prefixes: ["47"] },
  { id: "gyeongnam", label: "경남", prefixes: ["48"] },
  { id: "jeju", label: "제주", prefixes: ["50"] },
];

export type PriceMoveItem = {
  txId: string;
  aptName: string;
  href: string;
  regionLabel: string;
  dong: string;
  exclusiveArea: number;
  floor: number | null;
  dealAmount: number;
  dealDate: string;
  seenDate: string;
  priorMaxAmount: number;
  priorMaxDate: string | null;
  changeAmount: number;
  changePct: number;
  /** 같은 단지의 나머지 건수 (기간 안, 같은 종류) */
  moreCount: number;
};

export type PriceMovesResponse = {
  status: "ok" | "not_ready";
  kind: PriceMoveKind;
  period: PriceMovesPeriod;
  from: string;
  to: string;
  scopeLabel: string;
  counts: { singoga: number; drop: number };
  /** 기간 안 처음 확인된 매매 수 (같은 지역 범위) */
  seenTrades: number;
  topRegions: Array<{ lawdCd: string; label: string; href: string; count: number }>;
  items: PriceMoveItem[];
  totalGroups: number;
  hasMore: boolean;
};

let tableReady: boolean | null = null;
async function hasTable(db: Client): Promise<boolean> {
  if (tableReady) return true;
  const r = await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_price_moves'");
  tableReady = r.rows.length > 0;
  return tableReady;
}

function lawdLabel(lawd: string, gu: string): string {
  const reg = LAWD_TO_REGION[lawd];
  const name = districtNameFromCode(lawd) || gu || lawd;
  if (reg?.metro === "seoul") return `서울 ${name}`;
  return name;
}

function regionSlug(lawd: string): string {
  return LAWD_TO_REGION[lawd]?.slug ?? slugFromLawd("", lawd);
}

type Scope = { where: string; args: string[]; label: string };

function scopeFor(opts: { region?: string | null; sido?: string | null }): Scope {
  if (opts.region) {
    const reg = getRegion(opts.region);
    if (reg && reg.lawdCodes.length) {
      return {
        where: `lawd_cd IN (${reg.lawdCodes.map(() => "?").join(",")})`,
        args: reg.lawdCodes,
        label: reg.name,
      };
    }
  }
  const sido = PRICE_MOVES_SIDO.find((s) => s.id === opts.sido);
  if (sido) {
    return {
      where: `(${sido.prefixes.map(() => "substr(lawd_cd, 1, 2) = ?").join(" OR ")})`,
      args: sido.prefixes,
      label: sido.label,
    };
  }
  return { where: "1 = 1", args: [], label: "전국" };
}

export async function readPriceMoves(
  db: Client,
  opts: {
    kind: PriceMoveKind;
    period: PriceMovesPeriod;
    region?: string | null;
    sido?: string | null;
    area: PriceMovesArea;
    sort: PriceMovesSort;
    offset: number;
    limit: number;
  },
): Promise<PriceMovesResponse> {
  const today = seoulToday();
  const scope = scopeFor(opts);
  const notReady = !(await hasTable(db));
  // 기간 끝 = 마지막 확인일 (오늘 이하). 자정~다음 갱신 사이(연휴 포함)엔 오늘 기록이 없어
  // 오늘로 자르면 0건 — 시장 홈(마지막 확인일 기준) 숫자와 어긋난다. MAX는 (seen_date, kind) 인덱스로 끝난다.
  let to = today;
  if (!notReady) {
    const latest = await db.execute({
      sql: "SELECT MAX(seen_date) AS d FROM market_price_moves WHERE seen_date <= ?",
      args: [today],
    });
    const d = String(latest.rows[0]?.d ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) to = d;
  }
  const from = addDays(to, -(PRICE_MOVES_PERIODS[opts.period].days - 1));
  const base = {
    kind: opts.kind,
    period: opts.period,
    from,
    to,
    scopeLabel: scope.label,
  };
  if (notReady) {
    return {
      status: "not_ready",
      ...base,
      counts: { singoga: 0, drop: 0 },
      seenTrades: 0,
      topRegions: [],
      items: [],
      totalGroups: 0,
      hasMore: false,
    };
  }
  const [amin, amax] = AREA[opts.area];
  const where = `seen_date >= ? AND seen_date <= ? AND ${scope.where} AND exclusive_area >= ? AND exclusive_area <= ?`;
  const args = [from, to, ...scope.args, amin, amax];

  const activityCol = (await hasDiscoveryAtColumn(db)) ? "discovery_at" : "first_seen_at";
  const { startIso } = seoulDayBoundsUtc(from);
  const { endIso } = seoulDayBoundsUtc(to);

  const [countRes, seenRes, regionRes, rowsRes] = await Promise.all([
    db.execute({ sql: `SELECT kind, COUNT(*) AS n FROM market_price_moves WHERE ${where} GROUP BY kind`, args }),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM transactions
            WHERE deal_type = 'trade' AND ${activityCol} >= ? AND ${activityCol} < ?
              AND ${scope.where} AND exclusive_area >= ? AND exclusive_area <= ?`,
      args: [startIso, endIso, ...scope.args, amin, amax],
    }),
    db.execute({
      sql: `SELECT lawd_cd, MIN(gu) AS gu, COUNT(*) AS n FROM market_price_moves
            WHERE ${where} AND kind = ? GROUP BY lawd_cd ORDER BY n DESC LIMIT 5`,
      args: [...args, opts.kind],
    }),
    db.execute({
      sql: `SELECT tx_id, lawd_cd, apt_name, apt_name_norm, gu, dong, exclusive_area, floor, deal_amount,
                   deal_date, seen_date, prior_max_amount, prior_max_date, change_amount, change_pct
            FROM market_price_moves WHERE ${where} AND kind = ?
            LIMIT 20000`,
      args: [...args, opts.kind],
    }),
  ]);

  const counts = { singoga: 0, drop: 0 };
  for (const r of countRes.rows) counts[String(r.kind) as PriceMoveKind] = Number(r.n) || 0;

  // 단지별 묶기 — 대표는 변화가 가장 큰 거래 (하락은 가장 많이 떨어진 거래)
  type Row = (typeof rowsRes.rows)[number];
  const groups = new Map<string, Row[]>();
  for (const r of rowsRes.rows) {
    const k = `${r.lawd_cd}|${r.apt_name_norm}`;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const pick = (list: Row[]) =>
    list.reduce((best, r) =>
      opts.kind === "singoga"
        ? Number(r.change_amount) > Number(best.change_amount) ? r : best
        : Number(r.change_pct) < Number(best.change_pct) ? r : best,
    );
  const reps = [...groups.values()].map((list) => ({ rep: pick(list), n: list.length }));
  const sign = opts.kind === "singoga" ? 1 : -1;
  reps.sort((a, b) => {
    if (opts.sort === "recent") {
      return String(b.rep.seen_date).localeCompare(String(a.rep.seen_date)) || String(b.rep.deal_date).localeCompare(String(a.rep.deal_date));
    }
    const ka = opts.sort === "pct" ? Number(a.rep.change_pct) : Number(a.rep.change_amount);
    const kb = opts.sort === "pct" ? Number(b.rep.change_pct) : Number(b.rep.change_amount);
    return sign * (kb - ka);
  });
  const page = reps.slice(opts.offset, opts.offset + opts.limit);

  return {
    status: "ok",
    ...base,
    counts,
    seenTrades: Number(seenRes.rows[0]?.n) || 0,
    topRegions: regionRes.rows.map((r) => {
      const lawd = String(r.lawd_cd);
      return {
        lawdCd: lawd,
        label: lawdLabel(lawd, String(r.gu ?? "")),
        href: `/region/${regionSlug(lawd)}`,
        count: Number(r.n) || 0,
      };
    }),
    items: page.map(({ rep, n }) => {
      const lawd = String(rep.lawd_cd);
      const gu = String(rep.gu ?? "");
      const fl = Number(rep.floor);
      return {
        txId: String(rep.tx_id),
        aptName: String(rep.apt_name),
        href: aptDetailHref(String(rep.apt_name), regionSlug(lawd), gu || undefined),
        regionLabel: lawdLabel(lawd, gu),
        dong: String(rep.dong ?? ""),
        exclusiveArea: Number(rep.exclusive_area),
        floor: Number.isFinite(fl) ? fl : null,
        dealAmount: Number(rep.deal_amount),
        dealDate: String(rep.deal_date),
        seenDate: String(rep.seen_date),
        priorMaxAmount: Number(rep.prior_max_amount),
        priorMaxDate: rep.prior_max_date ? String(rep.prior_max_date) : null,
        changeAmount: Number(rep.change_amount),
        changePct: Number(rep.change_pct),
        moreCount: n - 1,
      };
    }),
    totalGroups: reps.length,
    hasMore: opts.offset + opts.limit < reps.length,
  };
}
