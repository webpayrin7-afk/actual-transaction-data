/**
 * Nearby APT 분양 announcements by 시군구 (청약홈 Applyhome OpenAPI).
 * Server-only. No DB writes. Daily fetch cache via next.revalidate.
 */

import { formatEok } from "@/lib/utils/format";

const DETAIL_BASE =
  "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail";
const MODEL_BASE =
  "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl";
const CMPET_BASE =
  "https://api.odcloud.kr/api/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet";

const DAILY_REVALIDATE = 86_400;
const MAX_TYPES = 3;
const RANK_1 = 1;
const RESIDE_LOCAL = "01";

export type NearbySaleStatus =
  | "upcoming"
  | "open"
  | "receipt_closed"
  | "winner_announced"
  | "contracting"
  | "completed";

export type NearbySaleTypeCard = {
  modelNo: string;
  label: string;
  topAmountManwon: number;
  topAmountLabel: string;
};

export type NearbySaleCard = {
  id: string;
  houseManageNo: string;
  pblancNo: string;
  houseName: string;
  status: NearbySaleStatus;
  statusLabel: string;
  scheduleLabel: string | null;
  regionLabel: string;
  supplyHouseholds: number | null;
  moveInYm: string | null;
  moveInLabel: string | null;
  types: NearbySaleTypeCard[];
  competition: {
    rankCode: number;
    resideSecd: string;
    rate: number;
    label: string;
  } | null;
  pblancUrl: string | null;
  rcritPblancDe: string | null;
};

export type NearbySalesResult = {
  status: "READY" | "EMPTY" | "NO_SIGUNGU" | "NO_API_KEY" | "ERROR";
  reason: string;
  sigungu: string | null;
  items: NearbySaleCard[];
  attribution: string;
  notice: string;
};

type OdcloudPage<T> = {
  currentCount?: number;
  matchCount?: number;
  totalCount?: number;
  data?: T[];
};

type DetailRow = {
  HOUSE_MANAGE_NO?: string | number;
  PBLANC_NO?: string | number;
  HOUSE_NM?: string;
  HSSPLY_ADRES?: string;
  SUBSCRPT_AREA_CODE_NM?: string;
  TOT_SUPLY_HSHLDCO?: string | number;
  RCRIT_PBLANC_DE?: string;
  RCEPT_BGNDE?: string;
  RCEPT_ENDDE?: string;
  PRZWNER_PRESNATN_DE?: string;
  CNTRCT_CNCLS_BGNDE?: string;
  CNTRCT_CNCLS_ENDDE?: string;
  MVN_PREARNGE_YM?: string;
  PBLANC_URL?: string;
};

type ModelRow = {
  HOUSE_MANAGE_NO?: string | number;
  PBLANC_NO?: string | number;
  MODEL_NO?: string | number;
  HOUSE_TY?: string;
  SUPLY_HSHLDCO?: string | number;
  LTTOT_TOP_AMOUNT?: string | number;
};

type CmpetRow = {
  HOUSE_MANAGE_NO?: string | number;
  PBLANC_NO?: string | number;
  MODEL_NO?: string | number;
  SUBSCRPT_RANK_CODE?: string | number;
  RESIDE_SECD?: string;
  CMPET_RATE?: string | number;
};

const STATUS_LABEL: Record<NearbySaleStatus, string> = {
  upcoming: "청약 예정",
  open: "청약 중",
  receipt_closed: "접수 종료",
  winner_announced: "당첨자 발표",
  contracting: "계약 진행",
  completed: "분양 완료",
};

const STATUS_ORDER: Record<NearbySaleStatus, number> = {
  upcoming: 0,
  open: 1,
  receipt_closed: 2,
  winner_announced: 3,
  contracting: 4,
  completed: 5,
};

function serviceKey(): string | null {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) return null;
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw: string | null | undefined): Date | null {
  const s = str(raw).replace(/\./g, "-");
  if (!s) return null;
  let y: number;
  let m: number;
  let d: number;
  if (/^\d{8}$/.test(s)) {
    y = Number(s.slice(0, 4));
    m = Number(s.slice(4, 6));
    d = Number(s.slice(6, 8));
  } else {
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m2) return null;
    y = Number(m2[1]);
    m = Number(m2[2]);
    d = Number(m2[3]);
  }
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function todayUtc(): Date {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 12, 0, 0),
  );
}


function formatMoveInYm(ym: string | null): string | null {
  if (!ym) return null;
  const s = ym.replace(/[^0-9]/g, "");
  if (s.length < 6) return null;
  return `${s.slice(0, 4)}.${s.slice(4, 6)}`;
}

/** "059.8151B" → "59B" */
export function formatHouseTypeLabel(houseTy: string): string {
  const t = houseTy.trim();
  const m = t.match(/^0*(\d+)(?:\.\d+)?\s*([A-Za-z])?/);
  if (!m) return t;
  return `${m[1]}${(m[2] ?? "").toUpperCase()}`;
}

function classifyStatus(row: DetailRow, today: Date): NearbySaleStatus {
  const rceptStart = parseDate(row.RCEPT_BGNDE);
  const rceptEnd = parseDate(row.RCEPT_ENDDE);
  const contractStart = parseDate(row.CNTRCT_CNCLS_BGNDE);
  const contractEnd = parseDate(row.CNTRCT_CNCLS_ENDDE);
  const winner = parseDate(row.PRZWNER_PRESNATN_DE);

  if (rceptStart && today < rceptStart) return "upcoming";
  if (rceptStart && rceptEnd && today >= rceptStart && today <= rceptEnd) {
    return "open";
  }
  if (rceptEnd && today > rceptEnd) {
    if (contractEnd && today > contractEnd) return "completed";
    if (
      contractStart &&
      contractEnd &&
      today >= contractStart &&
      today <= contractEnd
    ) {
      return "contracting";
    }
    if (contractStart && today >= contractStart && !contractEnd) {
      return "contracting";
    }
    if (winner && today >= winner) {
      if (contractStart && today < contractStart) return "winner_announced";
      if (!contractStart) return "winner_announced";
    }
    if (winner && today < winner) return "receipt_closed";
    if (contractStart && today < contractStart) return "receipt_closed";
    if (!contractEnd && !winner) return "receipt_closed";
  }
  return "completed";
}

function formatMd(d: Date | null): string | null {
  if (!d) return null;
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}.${day}`;
}

function scheduleLabelFor(
  status: NearbySaleStatus,
  row: DetailRow,
): string | null {
  const rceptStart = formatMd(parseDate(row.RCEPT_BGNDE));
  const rceptEnd = formatMd(parseDate(row.RCEPT_ENDDE));
  const winner = formatMd(parseDate(row.PRZWNER_PRESNATN_DE));
  const cStart = formatMd(parseDate(row.CNTRCT_CNCLS_BGNDE));
  const cEnd = formatMd(parseDate(row.CNTRCT_CNCLS_ENDDE));

  switch (status) {
    case "upcoming":
      return rceptStart ? `1순위 ${rceptStart}` : null;
    case "open":
      return rceptEnd ? `접수 ~${rceptEnd}` : null;
    case "receipt_closed":
      return winner ? `당첨발표 ${winner}` : null;
    case "winner_announced":
      if (cStart && cEnd) return `계약 ${cStart}~${cEnd}`;
      if (cStart) return `계약 ${cStart}`;
      if (cEnd) return `계약 ~${cEnd}`;
      return null;
    case "contracting":
      return cEnd ? `계약 ~${cEnd}` : cStart ? `계약 ${cStart}` : null;
    default:
      return null;
  }
}

async function odcloudGet<T>(
  base: string,
  params: Record<string, string>,
): Promise<T[]> {
  const key = serviceKey();
  if (!key) throw new Error("MOLIT_API_KEY missing");

  const all: T[] = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const qs = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      returnType: "JSON",
      ...params,
    });
    const url = `${base}?serviceKey=${key}&${qs.toString()}`;
    const res = await fetch(url, {
      next: { revalidate: DAILY_REVALIDATE },
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Applyhome HTTP ${res.status}`);
    }
    const body = (await res.json()) as OdcloudPage<T>;
    const chunk = body.data ?? [];
    all.push(...chunk);
    const match = body.matchCount ?? body.totalCount ?? chunk.length;
    if (chunk.length < perPage || all.length >= match || page >= 20) break;
    page += 1;
  }
  return all;
}

function pickTypes(models: ModelRow[]): NearbySaleTypeCard[] {
  const enriched: Array<NearbySaleTypeCard & { supply: number }> = [];
  for (const m of models) {
    const top = num(m.LTTOT_TOP_AMOUNT);
    const label = formatHouseTypeLabel(str(m.HOUSE_TY));
    const modelNo = str(m.MODEL_NO);
    const supply = num(m.SUPLY_HSHLDCO) ?? 0;
    if (!label || top == null || top <= 0) continue;
    enriched.push({
      modelNo,
      label,
      topAmountManwon: top,
      topAmountLabel: formatEok(top),
      supply,
    });
  }
  enriched.sort(
    (a, b) => b.supply - a.supply || b.topAmountManwon - a.topAmountManwon,
  );
  return enriched.slice(0, MAX_TYPES).map(({ supply: _s, ...rest }) => rest);
}

/** 1순위 해당지역 최고 경쟁률 — never sum across rank/reside buckets. */
function pickCompetition(
  rows: CmpetRow[],
): NearbySaleCard["competition"] {
  let best: number | null = null;
  for (const row of rows) {
    const rank = num(row.SUBSCRPT_RANK_CODE);
    const reside = str(row.RESIDE_SECD);
    if (rank !== RANK_1 || reside !== RESIDE_LOCAL) continue;
    const rateRaw = str(row.CMPET_RATE);
    if (!rateRaw || rateRaw === "-") continue;
    const rate = Number(rateRaw.replace(/,/g, ""));
    if (!Number.isFinite(rate) || rate < 0) continue;
    if (best == null || rate > best) best = rate;
  }
  if (best == null) return null;
  const rounded = Math.round(best * 100) / 100;
  return {
    rankCode: RANK_1,
    resideSecd: RESIDE_LOCAL,
    rate: rounded,
    label: `1순위 해당지역 최고 경쟁률 ${rounded} : 1`,
  };
}

function regionLabel(row: DetailRow, sigungu: string): string {
  const addr = str(row.HSSPLY_ADRES);
  const dong = addr.match(/([가-힣0-9]+(?:동|가))(?:\s|$)/)?.[1] ?? "";
  if (addr) {
    const m = addr.match(
      /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\s]*\s*([가-힣]+구|[가-힣]+시|[가-힣]+군)/,
    );
    if (m) {
      const base = `${m[1]} ${m[2]}`;
      return dong ? `${base} ${dong}` : base;
    }
    if (addr.includes(sigungu)) {
      const sido = str(row.SUBSCRPT_AREA_CODE_NM);
      const base = sido ? `${sido} ${sigungu}` : sigungu;
      return dong ? `${base} ${dong}` : base;
    }
  }
  const area = str(row.SUBSCRPT_AREA_CODE_NM);
  const base = area ? `${area} ${sigungu}` : sigungu;
  return dong ? `${base} ${dong}` : base;
}

async function buildCard(
  row: DetailRow,
  sigungu: string,
  today: Date,
): Promise<NearbySaleCard | null> {
  const houseManageNo = str(row.HOUSE_MANAGE_NO);
  const pblancNo = str(row.PBLANC_NO);
  const houseName = str(row.HOUSE_NM);
  if (!houseManageNo || !pblancNo || !houseName) return null;

  const status = classifyStatus(row, today);
  if (status === "completed") return null;

  const [models, cmpet] = await Promise.all([
    odcloudGet<ModelRow>(MODEL_BASE, {
      "cond[HOUSE_MANAGE_NO::EQ]": houseManageNo,
      "cond[PBLANC_NO::EQ]": pblancNo,
    }),
    odcloudGet<CmpetRow>(CMPET_BASE, {
      "cond[HOUSE_MANAGE_NO::EQ]": houseManageNo,
      "cond[PBLANC_NO::EQ]": pblancNo,
    }).catch(() => [] as CmpetRow[]),
  ]);

  const moveInYm = str(row.MVN_PREARNGE_YM) || null;

  return {
    id: `${houseManageNo}:${pblancNo}`,
    houseManageNo,
    pblancNo,
    houseName,
    status,
    statusLabel: STATUS_LABEL[status],
    scheduleLabel: scheduleLabelFor(status, row),
    regionLabel: regionLabel(row, sigungu),
    supplyHouseholds: num(row.TOT_SUPLY_HSHLDCO),
    moveInYm,
    moveInLabel: formatMoveInYm(moveInYm),
    types: pickTypes(models),
    competition: pickCompetition(cmpet),
    pblancUrl: str(row.PBLANC_URL) || null,
    rcritPblancDe: str(row.RCRIT_PBLANC_DE) || null,
  };
}

export async function fetchNearbySalesBySigungu(
  sigunguRaw: string,
): Promise<NearbySalesResult> {
  const attribution = "출처: 청약홈 · 한국부동산원";
  const notice =
    "청약 일정과 공급조건은 실제 입주자모집공고를 확인하세요.";

  const sigungu = sigunguRaw.trim();
  if (!sigungu) {
    return {
      status: "NO_SIGUNGU",
      reason: "단지 시군구 정보가 없어 주변 분양을 조회할 수 없습니다.",
      sigungu: null,
      items: [],
      attribution,
      notice,
    };
  }
  if (!serviceKey()) {
    return {
      status: "NO_API_KEY",
      reason: "공공데이터 API 키가 없어 주변 분양 조회를 건너뜁니다.",
      sigungu,
      items: [],
      attribution,
      notice,
    };
  }

  try {
    const today = todayUtc();

    const details = await odcloudGet<DetailRow>(DETAIL_BASE, {
      "cond[HSSPLY_ADRES::LIKE]": sigungu,
    });

    const cards = (
      await Promise.all(
        details.map((row) => buildCard(row, sigungu, today)),
      )
    ).filter(Boolean) as NearbySaleCard[];

    cards.sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      return str(b.rcritPblancDe).localeCompare(str(a.rcritPblancDe));
    });

    return {
      status: cards.length > 0 ? "READY" : "EMPTY",
      reason:
        cards.length > 0
          ? ""
          : `현재 ${sigungu}에 진행 중이거나 예정된 APT 분양·청약 정보가 없습니다.`,
      sigungu,
      items: cards,
      attribution,
      notice,
    };
  } catch (err) {
    console.error(
      "[nearby-sales]",
      err instanceof Error ? err.message : "error",
    );
    return {
      status: "ERROR",
      reason: "주변 분양 정보를 불러오지 못했습니다.",
      sigungu,
      items: [],
      attribution,
      notice,
    };
  }
}
