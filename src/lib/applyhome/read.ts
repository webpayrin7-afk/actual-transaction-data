/**
 * 청약홈 사본(applyhome_*) 읽기 — 단지 조회 '청약 일정'·'최근 청약 경쟁률', 지역 조회 '입주 예정'.
 * 읽기 전용. 값은 원천 그대로(분양가 = 주택형별 최고 분양가, 만원). 경쟁률 = 1순위 접수 ÷ 일반공급 세대.
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { addDays } from "@/lib/market/keys";
import { seoulToday } from "@/lib/market/time";

export type ApplyhomeNotice = {
  id: string;
  name: string;
  place: string;
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
  competition: ApplyhomeCompetition[];
  moveIn: { fromYm: string; toYm: string; byMetro: Record<string, MoveInRegion[]> };
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { at: number; key: string; value: ApplyhomeOverview } | null = null;

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

type NoticeRow = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function toNotice(r: NoticeRow): ApplyhomeNotice {
  return {
    id: String(r.house_manage_no),
    name: String(r.house_nm),
    place: placeOf(str(r.lawd_cd), str(r.area_name)),
    kind: [str(r.house_secd_nm) === "APT" ? null : str(r.house_secd_nm), str(r.house_dtl_secd_nm)]
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

export async function readApplyhomeOverview(db: Client): Promise<ApplyhomeOverview> {
  const today = seoulToday();
  if (cache && cache.key === today && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const fromYm = ymOf(today, 1);
  const toYm = ymOf(today, 24);
  const [upcomingRes, compRes, moveRes] = await Promise.all([
    // 접수가 끝나지 않은 공고 (특별공급 시작일 → 1순위 시작일 순)
    db.execute({
      sql: `SELECT ${NOTICE_COLS} FROM applyhome_notices n
            WHERE n.rcept_end >= ?
            ORDER BY COALESCE(n.special_rcept_begin, n.rcept_begin), n.rcept_begin`,
      args: [today],
    }),
    // 최근 30일 안에 접수가 끝난 공고의 1순위 경쟁률
    db.execute({
      sql: `SELECT ${NOTICE_COLS},
                   (SELECT SUM(general_supply) FROM applyhome_models m WHERE m.house_manage_no = n.house_manage_no) AS general_supply,
                   (SELECT SUM(request_count) FROM applyhome_competition c
                     WHERE c.house_manage_no = n.house_manage_no AND c.rank_code = 1) AS first_rank_requests
            FROM applyhome_notices n
            WHERE n.rcept_end >= ? AND n.rcept_end < ?`,
      args: [addDays(today, -30), today],
    }),
    // 앞으로 24개월 입주 예정 (공급 세대 기준)
    db.execute({
      sql: `SELECT lawd_cd, move_in_ym, total_supply FROM applyhome_notices
            WHERE lawd_cd IS NOT NULL AND move_in_ym BETWEEN ? AND ? AND total_supply > 0
              AND COALESCE(rent_secd_nm, '') <> '임대주택'`,
      args: [fromYm, toYm],
    }),
  ]);

  const upcoming = upcomingRes.rows.map((r) => toNotice(r as NoticeRow));
  const competition = compRes.rows
    .map((r) => {
      const g = Number(r.general_supply ?? 0);
      const q = Number(r.first_rank_requests ?? 0);
      return { ...toNotice(r as NoticeRow), generalSupply: g, firstRankRequests: q, rate: g > 0 ? q / g : 0 };
    })
    .filter((x) => x.generalSupply >= 10 && x.firstRankRequests > 0)
    .sort((a, b) => b.rate - a.rate)
    .map((x) => ({ ...x, rate: Math.round(x.rate * 10) / 10 }));

  const agg = new Map<string, MoveInRegion & { metro: string }>();
  for (const r of moveRes.rows) {
    const lawd = String(r.lawd_cd);
    const reg = LAWD_TO_REGION[lawd];
    const slug = reg?.slug ?? slugFromLawd("", lawd);
    const ym = String(r.move_in_ym);
    const e =
      agg.get(slug) ??
      { slug, name: reg?.name ?? districtNameFromCode(lawd), metro: reg?.metro ?? "other", households: 0, projects: 0, firstYm: ym, lastYm: ym };
    e.households += Number(r.total_supply);
    e.projects += 1;
    if (ym < e.firstYm) e.firstYm = ym;
    if (ym > e.lastYm) e.lastYm = ym;
    agg.set(slug, e);
  }
  const byMetro: Record<string, MoveInRegion[]> = {};
  for (const { metro, ...e } of agg.values()) (byMetro[metro] ??= []).push(e);
  for (const list of Object.values(byMetro)) list.sort((a, b) => b.households - a.households);

  const value = { today, upcoming, competition, moveIn: { fromYm, toYm, byMetro } };
  cache = { at: Date.now(), key: today, value };
  return value;
}
