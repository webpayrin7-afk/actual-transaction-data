/**
 * 시장 홈 '오늘의 기록' — 오늘(KST) 처음 확인된 매매에서 날마다 다섯 가지 기록을 하나씩 뽑는다.
 *  1 가장 비싼 거래   2 가장 크게 오른 신고가   3 가장 오래된 고점을 넘은 신고가
 *  4 가장 많이 떨어진 거래   5 오늘 거래가 가장 많이 확인된 단지
 * 1·5는 transactions(오늘 확인분)에서, 2·3·4는 market_price_moves(신고가·하락 기록)에서 읽는다.
 * 기록이 없으면 그 칸은 비운다(추정 없음). 읽기 전용.
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { hasDiscoveryAtColumn } from "@/lib/db/discovery-axis";
import { seoulDayBoundsUtc } from "@/lib/market/time";
import { aptDetailHref } from "@/lib/molit/apt-client";

/** 신고가·하락 기록(2·3·4)에 쓰는 최소 전용면적 (㎡) */
const MIN_RECORD_AREA = 40;

export type RecordKind = "top-price" | "biggest-rise" | "oldest-peak" | "biggest-drop" | "busiest";

export type MarketRecord = {
  kind: RecordKind;
  /** 이유 태그 (예: "가장 비싼 거래", "12년 만의 최고가") */
  reason: string;
  aptName: string;
  href: string;
  place: string;
  exclusiveArea: number | null;
  floor: number | null;
  dealAmount: number | null;
  dealDate: string | null;
  /** 두 번째 줄 설명 (예: "직전 13.5억(18.02) +6.5억") */
  detail: string;
  /** 오른쪽 아래 작은 값 (예: "+48.1%", "5건") */
  sub: string | null;
  tone: "up" | "down" | null;
};

export type MarketRecordsResponse = {
  date: string;
  records: MarketRecord[];
  /** 신고가·하락 기록이 오늘치까지 만들어졌는지 (없으면 2·3·4는 비어 있음) */
  movesReady: boolean;
};

function regionSlug(lawd: string): string {
  return LAWD_TO_REGION[lawd]?.slug ?? slugFromLawd("", lawd);
}

function placeOf(lawd: string, gu: string, dong: string): string {
  const name = districtNameFromCode(lawd) || gu;
  return `${name} ${dong}`.trim();
}

function eok(man: number): string {
  const e = man / 10_000;
  return e >= 1 ? `${Math.round(e * 10) / 10}억` : `${man.toLocaleString("ko-KR")}만`;
}

function ym2(iso: string | null): string {
  return iso ? `${iso.slice(2, 4)}.${iso.slice(5, 7)}` : "";
}

function yearsBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / (365.25 * 86_400_000);
}

export async function readMarketRecords(db: Client, date: string): Promise<MarketRecordsResponse> {
  const activityCol = (await hasDiscoveryAtColumn(db)) ? "discovery_at" : "first_seen_at";
  const { startIso, endIso } = seoulDayBoundsUtc(date);

  const movesTable = await db
    .execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_price_moves'")
    .then((r) => r.rows.length > 0);

  const [seenRes, movesRes] = await Promise.all([
    db.execute({
      sql: `SELECT lawd_cd, apt_name, apt_name_norm, gu, dong, exclusive_area, floor, deal_amount, deal_date
            FROM transactions
            WHERE deal_type = 'trade' AND ${activityCol} >= ? AND ${activityCol} < ?`,
      args: [startIso, endIso],
    }),
    movesTable
      ? db.execute({
          sql: `SELECT kind, lawd_cd, apt_name, gu, dong, exclusive_area, floor, deal_amount, deal_date,
                       prior_max_amount, prior_max_date, change_amount, change_pct
                FROM market_price_moves WHERE seen_date = ?`,
          args: [date],
        })
      : Promise.resolve(null),
  ]);

  const records: MarketRecord[] = [];
  const seen = seenRes.rows;

  // 1 가장 비싼 거래
  const top = seen.reduce<(typeof seen)[number] | null>(
    (best, r) => (!best || Number(r.deal_amount) > Number(best.deal_amount) ? r : best),
    null,
  );
  if (top && Number(top.deal_amount) > 0) {
    const lawd = String(top.lawd_cd);
    const gu = String(top.gu ?? "");
    records.push({
      kind: "top-price",
      reason: "가장 비싼 거래",
      aptName: String(top.apt_name),
      href: aptDetailHref(String(top.apt_name), regionSlug(lawd), gu || undefined),
      place: placeOf(lawd, gu, String(top.dong ?? "")),
      exclusiveArea: Number(top.exclusive_area) || null,
      floor: Number.isFinite(Number(top.floor)) ? Number(top.floor) : null,
      dealAmount: Number(top.deal_amount),
      dealDate: String(top.deal_date),
      detail: `${String(top.deal_date).slice(5).replace("-", ".")} 계약`,
      sub: null,
      tone: null,
    });
  }

  const moves = movesRes?.rows ?? [];
  const movesReady = moves.length > 0;
  const moveRecord = (
    r: (typeof moves)[number],
    kind: RecordKind,
    reason: string,
    tone: "up" | "down",
  ): MarketRecord => {
    const lawd = String(r.lawd_cd);
    const gu = String(r.gu ?? "");
    const change = Number(r.change_amount);
    return {
      kind,
      reason,
      aptName: String(r.apt_name),
      href: aptDetailHref(String(r.apt_name), regionSlug(lawd), gu || undefined),
      place: placeOf(lawd, gu, String(r.dong ?? "")),
      exclusiveArea: Number(r.exclusive_area) || null,
      floor: Number.isFinite(Number(r.floor)) ? Number(r.floor) : null,
      dealAmount: Number(r.deal_amount),
      dealDate: String(r.deal_date),
      detail: `${tone === "up" ? "직전" : "고점"} ${eok(Number(r.prior_max_amount))}${
        r.prior_max_date ? `(${ym2(String(r.prior_max_date))})` : ""
      } ${change > 0 ? "+" : "−"}${eok(Math.abs(change))}`,
      sub: `${Number(r.change_pct) > 0 ? "+" : ""}${Number(r.change_pct)}%`,
      tone,
    };
  };

  // 초소형(전용 40㎡ 미만)은 값이 크게 출렁여 "기록"으로 쓰지 않는다 (원룸형·도시형 등)
  const sizable = moves.filter((r) => Number(r.exclusive_area) >= MIN_RECORD_AREA);
  const singoga = sizable.filter((r) => r.kind === "singoga");
  const drops = sizable.filter((r) => r.kind === "drop");

  // 2 가장 크게 오른 신고가 (금액)
  const rise = singoga.reduce<(typeof moves)[number] | null>(
    (best, r) => (!best || Number(r.change_amount) > Number(best.change_amount) ? r : best),
    null,
  );
  if (rise) records.push(moveRecord(rise, "biggest-rise", "가장 크게 오른 신고가", "up"));

  // 3 가장 오래된 고점을 넘은 신고가 (2와 다른 거래, 1년 이상 만일 때만)
  const oldest = singoga
    .filter((r) => r.prior_max_date && r !== rise)
    .reduce<(typeof moves)[number] | null>(
      (best, r) => (!best || String(r.prior_max_date) < String(best.prior_max_date) ? r : best),
      null,
    );
  if (oldest) {
    const years = Math.floor(yearsBetween(String(oldest.prior_max_date), String(oldest.deal_date)));
    if (years >= 1) records.push(moveRecord(oldest, "oldest-peak", `${years}년 만의 최고가`, "up"));
  }

  // 4 가장 많이 떨어진 거래 (비율)
  const drop = drops.reduce<(typeof moves)[number] | null>(
    (best, r) => (!best || Number(r.change_pct) < Number(best.change_pct) ? r : best),
    null,
  );
  if (drop) records.push(moveRecord(drop, "biggest-drop", "가장 많이 떨어진 거래", "down"));

  // 5 오늘 거래가 가장 많이 확인된 단지 (2건 이상일 때만)
  const byComplex = new Map<string, (typeof seen)[number][]>();
  for (const r of seen) {
    const k = `${r.lawd_cd}|${r.apt_name_norm}`;
    const list = byComplex.get(k) ?? [];
    list.push(r);
    byComplex.set(k, list);
  }
  const busiest = [...byComplex.values()].sort(
    (a, b) =>
      b.length - a.length ||
      b.reduce((n, r) => n + Number(r.deal_amount), 0) - a.reduce((n, r) => n + Number(r.deal_amount), 0),
  )[0];
  if (busiest && busiest.length >= 2) {
    const r = busiest[0]!;
    const lawd = String(r.lawd_cd);
    const gu = String(r.gu ?? "");
    const amounts = busiest.map((x) => Number(x.deal_amount)).filter((v) => v > 0).sort((a, b) => a - b);
    records.push({
      kind: "busiest",
      reason: "오늘 거래가 가장 많은 단지",
      aptName: String(r.apt_name),
      href: aptDetailHref(String(r.apt_name), regionSlug(lawd), gu || undefined),
      place: placeOf(lawd, gu, String(r.dong ?? "")),
      exclusiveArea: null,
      floor: null,
      dealAmount: null,
      dealDate: null,
      detail:
        amounts.length > 1
          ? `${eok(amounts[0]!)} ~ ${eok(amounts.at(-1)!)}`
          : amounts.length
            ? eok(amounts[0]!)
            : "",
      sub: null,
      tone: null,
    });
    // 오른쪽 값 자리에 건수를 쓴다
    records.at(-1)!.sub = `${busiest.length}건`;
  }

  return { date, records, movesReady };
}
