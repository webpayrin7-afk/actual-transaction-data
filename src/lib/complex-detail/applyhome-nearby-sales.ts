/**
 * Nearby APT + officetel supply by 시군구 코드(lawd 5자리).
 * 아파트: 청약홈 사본(applyhome_notices/models/competition)에서 lawd_cd 정확 일치.
 *   lawd_cd 가 빈 공고는 주소를 다시 읽고, 구 없이 시 이름만 있으면 그 시 전체로 본다.
 * 오피스텔: 청약홈 OpenAPI 라이브(daily fetch cache) → 주소를 코드로 다시 읽어 같은 시군구만.
 * Server-only. No DB writes.
 */

import type { Client } from "@libsql/client";
import {
  LEGACY_LAWD_SUCCESSORS,
  dongScopeCodes,
  legacyLawdCodesOf,
  legacyLawdNamesOf,
  matchCityLawds,
  matchLawd,
  type DongIndex,
} from "@/lib/applyhome/lawd-match";
import { NATIONWIDE_LAWD_ROWS } from "@/lib/constants/nationwide-lawd";
import { districtNameFromCode } from "@/lib/constants/regions-registry";
import { getDb } from "@/lib/db/client";
import { formatEok } from "@/lib/utils/format";

const OFFICETEL_DETAIL_BASE =
  "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getUrbtyOfctlLttotPblancDetail";
const OFFICETEL_MODEL_BASE =
  "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getUrbtyOfctlLttotPblancMdl";

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
  | "move_in_upcoming"
  | "completed";

export type NearbyHousingCategory = "apartment" | "officetel";
export type NearbySaleSource = "applyhome:apt" | "applyhome:officetel";

export type NearbySaleTypeCard = {
  modelNo: string;
  label: string;
  topAmountManwon: number | null;
  topAmountLabel: string | null;
};

export type NearbySaleCard = {
  id: string;
  source: NearbySaleSource;
  housingCategory: NearbyHousingCategory;
  houseManageNo: string;
  pblancNo: string;
  houseName: string;
  status: NearbySaleStatus;
  statusLabel: string;
  scheduleLabel: string | null;
  regionLabel: string;
  supplyCount: number | null;
  supplyCountLabel: string | null;
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
  TP?: string;
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
  move_in_upcoming: "입주 예정",
  completed: "분양 완료",
};

const STATUS_ORDER: Record<NearbySaleStatus, number> = {
  upcoming: 0,
  open: 1,
  receipt_closed: 2,
  winner_announced: 3,
  contracting: 4,
  move_in_upcoming: 5,
  completed: 6,
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

function currentYm(today: Date): string {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function normalizeYm(ym: string | null | undefined): string | null {
  if (!ym) return null;
  const s = ym.replace(/[^0-9]/g, "");
  return s.length >= 6 ? s.slice(0, 6) : null;
}

function isFutureMoveIn(ym: string | null, today: Date): boolean {
  const n = normalizeYm(ym);
  if (!n) return false;
  return n >= currentYm(today);
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
  timeoutMs = 30_000,
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
      signal: AbortSignal.timeout(timeoutMs),
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

function pickTypes(
  models: ModelRow[],
  opts: { requirePrice: boolean },
): NearbySaleTypeCard[] {
  const enriched: Array<NearbySaleTypeCard & { supply: number }> = [];
  for (const m of models) {
    const labelRaw = str(m.HOUSE_TY) || str(m.TP);
    const label = formatHouseTypeLabel(labelRaw);
    const modelNo = str(m.MODEL_NO);
    const supply = num(m.SUPLY_HSHLDCO) ?? 0;
    if (!label) continue;
    const top = num(m.LTTOT_TOP_AMOUNT);
    if (opts.requirePrice) {
      if (top == null || top <= 0) continue;
      enriched.push({
        modelNo,
        label,
        topAmountManwon: top,
        topAmountLabel: formatEok(top),
        supply,
      });
    } else {
      enriched.push({
        modelNo,
        label,
        topAmountManwon: null,
        topAmountLabel: null,
        supply,
      });
    }
  }
  enriched.sort(
    (a, b) =>
      b.supply - a.supply || (b.topAmountManwon ?? 0) - (a.topAmountManwon ?? 0),
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

/** 청약 일정으로 본 상태 — 분양이 끝났고 입주도 지났으면 null (목록에서 뺀다) */
function cardStatus(row: DetailRow, today: Date): NearbySaleStatus | null {
  const status = classifyStatus(row, today);
  if (status !== "completed") return status;
  return isFutureMoveIn(str(row.MVN_PREARNGE_YM) || null, today)
    ? "move_in_upcoming"
    : null;
}

function toCard(
  row: DetailRow,
  status: NearbySaleStatus,
  sigungu: string,
  kind: NearbyHousingCategory,
  models: ModelRow[],
  cmpet: CmpetRow[],
): NearbySaleCard | null {
  const houseManageNo = str(row.HOUSE_MANAGE_NO);
  const pblancNo = str(row.PBLANC_NO);
  const houseName = str(row.HOUSE_NM);
  if (!houseManageNo || !pblancNo || !houseName) return null;

  const source: NearbySaleSource =
    kind === "officetel" ? "applyhome:officetel" : "applyhome:apt";
  const moveInYm = str(row.MVN_PREARNGE_YM) || null;
  const isMoveIn = status === "move_in_upcoming";
  const skipCmpet = isMoveIn || kind === "officetel";

  const supplyCount = num(row.TOT_SUPLY_HSHLDCO);
  const supplyCountLabel =
    supplyCount == null
      ? null
      : kind === "officetel"
        ? `${supplyCount.toLocaleString("ko-KR")}실`
        : `${supplyCount.toLocaleString("ko-KR")}세대`;

  return {
    id: `${source}:${houseManageNo}:${pblancNo}`,
    source,
    housingCategory: kind,
    houseManageNo,
    pblancNo,
    houseName,
    status,
    statusLabel: STATUS_LABEL[status],
    scheduleLabel: isMoveIn ? null : scheduleLabelFor(status, row),
    regionLabel: regionLabel(row, sigungu),
    supplyCount,
    supplyCountLabel,
    moveInYm,
    moveInLabel: formatMoveInYm(moveInYm),
    types: pickTypes(models, { requirePrice: kind === "apartment" }),
    competition: skipCmpet ? null : pickCompetition(cmpet),
    pblancUrl: str(row.PBLANC_URL) || null,
    rcritPblancDe: str(row.RCRIT_PBLANC_DE) || null,
  };
}

/** 단지 시군구 코드 + 그 코드가 이어받은 예전 인천 구 코드 → 이 공고 주소가 그 지역인가 */
type RegionScope = {
  codes: Set<string>;
  /** 주소를 다시 읽어야 할 때만 불러오는 법정동 색인 (codes 의 시·형제 구 범위) */
  dongIndex: () => Promise<DongIndex>;
};

function inScope(code: string | null, scope: RegionScope): boolean {
  if (!code) return false;
  if (scope.codes.has(code)) return true;
  // 동 이름으로 못 좁힌 예전 인천 구 공고 — 이어받은 새 구 모두에 보여 준다
  return (LEGACY_LAWD_SUCCESSORS[code] ?? []).some((c) => scope.codes.has(c));
}

/**
 * 공고의 시군구 코드. 저장된 코드가 있고 예전 인천 구 코드가 아니면 그대로,
 * 아니면(코드 없음 · 28110/28140/28260) 주소를 지금 표로 다시 읽는다 — 이름 정확 일치만.
 */
async function noticeLawd(
  stored: string | null,
  address: string,
  scope: RegionScope,
): Promise<string | null> {
  if (stored && !LEGACY_LAWD_SUCCESSORS[stored]) return stored;
  return (
    matchLawd(address, undefined) ??
    matchLawd(address, await scope.dongIndex(), { keepLegacy: true }) ??
    stored
  );
}

/**
 * 이 공고가 단지 지역 공고인가. 코드로 못 읽은 공고(동탄2·부천대장·성남낙생처럼 주소에 구·동 없이
 * 택지지구 이름만 있는 경우 — 사본 lawd_cd NULL)는 주소의 시 이름이 단지의 시와 정확히 같으면
 * 그 시의 구 모두에 보여 준다 (예전 주소 시군구 검색과 같은 범위, 부분 일치 없음).
 */
async function noticeInScope(
  stored: string | null,
  address: string,
  scope: RegionScope,
): Promise<boolean> {
  const code = await noticeLawd(stored, address, scope);
  if (code) return inScope(code, scope);
  return matchCityLawds(address).some((c) => scope.codes.has(c));
}

const dongIndexCache = new Map<string, { at: number; value: DongIndex }>();

function makeScope(db: Client, codes: string[]): RegionScope {
  const scopeCodes = dongScopeCodes(codes).sort();
  const key = scopeCodes.join(",");
  let pending: Promise<DongIndex> | null = null;
  return {
    codes: new Set(codes),
    dongIndex: () => {
      const hit = dongIndexCache.get(key);
      if (hit && Date.now() - hit.at < DAILY_REVALIDATE * 1000) {
        return Promise.resolve(hit.value);
      }
      pending ??= db
        .execute({
          sql: `SELECT DISTINCT lawd_cd, legal_dong_name FROM apt_complex_master
                WHERE lawd_cd IN (${scopeCodes.map(() => "?").join(",")}) AND legal_dong_name IS NOT NULL`,
          args: scopeCodes,
        })
        .then((res) => {
          const index: DongIndex = new Map();
          for (const r of res.rows) {
            const d = String(r.legal_dong_name);
            index.set(d, (index.get(d) ?? new Set<string>()).add(String(r.lawd_cd)));
          }
          dongIndexCache.set(key, { at: Date.now(), value: index });
          return index;
        });
      return pending;
    },
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 아파트(APT · 민간사전청약 · 신혼희망타운) — 청약홈 사본(applyhome_*)에서 시군구 코드 정확 일치로.
 * 무순위 공고는 새 공급이 아니라 뺀다. 사본은 scripts/applyhome/sync-applyhome.ts 가 매일 채운다.
 */
async function readAptCards(
  db: Client,
  scope: RegionScope,
  sigungu: string,
  today: Date,
): Promise<NearbySaleCard[]> {
  const codes = [...scope.codes];
  const lookup = [...new Set([...codes, ...codes.flatMap(legacyLawdCodesOf)])];
  const todayIso = isoDate(today);
  const res = await db.execute({
    sql: `SELECT house_manage_no, pblanc_no, house_nm, address, area_name, lawd_cd, total_supply,
                 notice_date, rcept_begin, rcept_end, winner_date, contract_begin, contract_end,
                 move_in_ym, notice_url
          FROM applyhome_notices
          WHERE (lawd_cd IN (${lookup.map(() => "?").join(",")}) OR lawd_cd IS NULL)
            AND notice_type IS NULL
            AND (move_in_ym >= ? OR rcept_end >= ? OR contract_end >= ? OR contract_end IS NULL)`,
    args: [...lookup, currentYm(today), todayIso, todayIso],
  });

  const rows: Array<{ row: DetailRow; status: NearbySaleStatus }> = [];
  for (const r of res.rows) {
    const inRegion = await noticeInScope(
      r.lawd_cd == null ? null : String(r.lawd_cd),
      str(r.address),
      scope,
    );
    if (!inRegion) continue;
    const row: DetailRow = {
      HOUSE_MANAGE_NO: str(r.house_manage_no),
      PBLANC_NO: str(r.pblanc_no) || str(r.house_manage_no),
      HOUSE_NM: str(r.house_nm),
      HSSPLY_ADRES: str(r.address),
      SUBSCRPT_AREA_CODE_NM: str(r.area_name),
      TOT_SUPLY_HSHLDCO: r.total_supply == null ? undefined : Number(r.total_supply),
      RCRIT_PBLANC_DE: str(r.notice_date),
      RCEPT_BGNDE: str(r.rcept_begin),
      RCEPT_ENDDE: str(r.rcept_end),
      PRZWNER_PRESNATN_DE: str(r.winner_date),
      CNTRCT_CNCLS_BGNDE: str(r.contract_begin),
      CNTRCT_CNCLS_ENDDE: str(r.contract_end),
      MVN_PREARNGE_YM: str(r.move_in_ym),
      PBLANC_URL: str(r.notice_url),
    };
    const status = cardStatus(row, today);
    if (status) rows.push({ row, status });
  }
  if (rows.length === 0) return [];

  const ids = rows.map((x) => str(x.row.HOUSE_MANAGE_NO));
  const marks = ids.map(() => "?").join(",");
  const [modelRes, cmpetRes] = await Promise.all([
    db.execute({
      sql: `SELECT house_manage_no, model_no, house_ty, general_supply, top_amount
            FROM applyhome_models WHERE house_manage_no IN (${marks})`,
      args: ids,
    }),
    db.execute({
      sql: `SELECT house_manage_no, model_no, rank_code, reside_code, competition_rate
            FROM applyhome_competition
            WHERE house_manage_no IN (${marks}) AND rank_code = ${RANK_1} AND reside_code = '${RESIDE_LOCAL}'`,
      args: ids,
    }),
  ]);
  const models = new Map<string, ModelRow[]>();
  for (const m of modelRes.rows) {
    const id = str(m.house_manage_no);
    models.set(id, [
      ...(models.get(id) ?? []),
      {
        MODEL_NO: str(m.model_no),
        HOUSE_TY: str(m.house_ty),
        SUPLY_HSHLDCO: m.general_supply == null ? undefined : Number(m.general_supply),
        LTTOT_TOP_AMOUNT: m.top_amount == null ? undefined : Number(m.top_amount),
      },
    ]);
  }
  const cmpet = new Map<string, CmpetRow[]>();
  for (const c of cmpetRes.rows) {
    const id = str(c.house_manage_no);
    cmpet.set(id, [
      ...(cmpet.get(id) ?? []),
      {
        MODEL_NO: str(c.model_no),
        SUBSCRPT_RANK_CODE: Number(c.rank_code),
        RESIDE_SECD: str(c.reside_code),
        CMPET_RATE: str(c.competition_rate),
      },
    ]);
  }

  return rows
    .map(({ row, status }) => {
      const id = str(row.HOUSE_MANAGE_NO);
      return toCard(row, status, sigungu, "apartment", models.get(id) ?? [], cmpet.get(id) ?? []);
    })
    .filter((c): c is NearbySaleCard => c != null);
}

const OFFICETEL_CALL_TIMEOUT_MS = 8_000;
const OFFICETEL_TOTAL_TIMEOUT_MS = 12_000;

/**
 * 오피스텔·도시형 — 사본이 없어 청약홈 라이브 조회. 주소 LIKE 는 부분 일치라(강서구 ⊃ 서구)
 * 받은 공고를 주소 → 시군구 코드로 다시 읽어 단지 지역과 정확히 같은 것만 남긴 뒤 주택형을 부른다.
 */
async function fetchOfficetelCards(
  scope: RegionScope,
  terms: string[],
  sigungu: string,
  today: Date,
): Promise<NearbySaleCard[]> {
  const pages = await Promise.all(
    terms.map((term) =>
      odcloudGet<DetailRow>(
        OFFICETEL_DETAIL_BASE,
        { "cond[HSSPLY_ADRES::LIKE]": term },
        OFFICETEL_CALL_TIMEOUT_MS,
      ),
    ),
  );
  const seen = new Set<string>();
  const rows: Array<{ row: DetailRow; status: NearbySaleStatus }> = [];
  for (const row of pages.flat()) {
    const key = `${str(row.HOUSE_MANAGE_NO)}:${str(row.PBLANC_NO)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = cardStatus(row, today);
    if (!status) continue;
    if (!(await noticeInScope(null, str(row.HSSPLY_ADRES), scope))) continue;
    rows.push({ row, status });
  }
  const cards = await Promise.all(
    rows.map(async ({ row, status }) => {
      const models = await odcloudGet<ModelRow>(
        OFFICETEL_MODEL_BASE,
        {
          "cond[HOUSE_MANAGE_NO::EQ]": str(row.HOUSE_MANAGE_NO),
          "cond[PBLANC_NO::EQ]": str(row.PBLANC_NO),
        },
        OFFICETEL_CALL_TIMEOUT_MS,
      ).catch(() => [] as ModelRow[]);
      return toCard(row, status, sigungu, "officetel", models, []);
    }),
  );
  return cards.filter((c): c is NearbySaleCard => c != null);
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 시군구 이름 → 코드. 전국에서 그 이름이 하나뿐일 때만 (강서구·중구처럼 여럿이면 null) */
export function uniqueLawdForSigungu(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  const hits = NATIONWIDE_LAWD_ROWS.filter((r) => {
    const parts = r.fullName.split(/\s+/);
    return parts[parts.length - 1] === n || parts.slice(1).join(" ") === n;
  });
  return hits.length === 1 ? hits[0]!.code : null;
}

/** 오피스텔 라이브 조회 주소 검색어 — 단지 시군구 이름 + 예전 인천 구 이름 (주소가 아직 옛 이름) */
function officetelTerms(codes: string[], sigungu: string): string[] {
  const names = sigungu
    ? [sigungu]
    : codes.slice(0, 3).map((c) => {
        const full = NATIONWIDE_LAWD_ROWS.find((r) => r.code === c)?.fullName ?? "";
        return full.split(/\s+/).pop() ?? "";
      });
  return [...new Set([...names, ...codes.flatMap(legacyLawdNamesOf)])].filter(Boolean);
}

export async function fetchNearbySales(input: {
  lawdCodes: string[];
  sigungu: string;
}): Promise<NearbySalesResult> {
  const attribution = "출처: 청약홈 · 한국부동산원";
  const notice =
    "청약 일정과 공급조건은 실제 입주자모집공고를 확인하세요.";

  const sigungu = input.sigungu.trim();
  const codes = input.lawdCodes.length
    ? input.lawdCodes
    : [uniqueLawdForSigungu(sigungu)].filter((c): c is string => c != null);
  if (codes.length === 0) {
    return {
      status: "NO_SIGUNGU",
      reason: "단지 시군구 정보가 없어 주변 공급을 조회할 수 없습니다.",
      sigungu: sigungu || null,
      items: [],
      attribution,
      notice,
    };
  }
  const db = getDb();
  if (!db) {
    return {
      status: "ERROR",
      reason: "주변 공급 정보를 불러오지 못했습니다.",
      sigungu: sigungu || null,
      items: [],
      attribution,
      notice,
    };
  }

  try {
    const today = todayUtc();
    const scope = makeScope(db, codes);
    const label = sigungu || districtNameFromCode(codes[0]!) || codes[0]!;

    const officetel = serviceKey()
      ? withTimeout(
          fetchOfficetelCards(scope, officetelTerms(codes, sigungu), label, today),
          OFFICETEL_TOTAL_TIMEOUT_MS,
          [] as NearbySaleCard[],
        ).catch((err) => {
          console.error(
            "[nearby-sales:officetel]",
            err instanceof Error ? err.message : "error",
          );
          return [] as NearbySaleCard[];
        })
      : Promise.resolve([] as NearbySaleCard[]);

    const [aptCards, officetelCards] = await Promise.all([
      readAptCards(db, scope, label, today),
      officetel,
    ]);

    const deduped: NearbySaleCard[] = [];
    const seen = new Set<string>();
    for (const card of [...aptCards, ...officetelCards]) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      deduped.push(card);
    }

    deduped.sort((a, b) => {
      const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (so !== 0) return so;
      if (a.status === "move_in_upcoming" && b.status === "move_in_upcoming") {
        return str(a.moveInYm).localeCompare(str(b.moveInYm));
      }
      return str(b.rcritPblancDe).localeCompare(str(a.rcritPblancDe));
    });

    return {
      status: deduped.length > 0 ? "READY" : "EMPTY",
      reason:
        deduped.length > 0
          ? ""
          : `현재 ${label}에 확인된 청약·입주예정 주택이 없습니다.`,
      sigungu: label,
      items: deduped,
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
      reason: "주변 공급 정보를 불러오지 못했습니다.",
      sigungu: sigungu || null,
      items: [],
      attribution,
      notice,
    };
  }
}
