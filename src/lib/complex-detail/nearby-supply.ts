/**
 * 주변 공급 normalization.
 * Query geography is REGION_SUPPLY / SIGUNGU_SCOPE — not a physical radius.
 * One announcement → one card. No DB access.
 */

export const SUPPLY_EMPTY_MESSAGE = "현재 확인된 주변 공급 일정이 없습니다.";
export const SUPPLY_UNAVAILABLE_MESSAGE =
  "주변 공급 정보를 불러오지 못했습니다.";
export const SUPPLY_NO_REGION_MESSAGE =
  "단지 지역 정보가 없어 주변 공급을 표시할 수 없습니다.";
export const SUPPLY_LOADING_MESSAGE = "주변 공급 정보를 불러오는 중…";
export const SUPPLY_SCOPE_TIP =
  "청약홈 공개 정보를 기준으로 해당 지역의 진행 중 청약과 향후 입주 예정 공급을 보여줍니다.";

export type NearbySupplySectionStatus = "AVAILABLE" | "EMPTY" | "UNAVAILABLE";

export type NearbySaleSource = "applyhome:apt" | "applyhome:officetel";
export type NearbySourceType = "APT" | "OFFICETEL";

/** One representative status per announcement. */
export type NearbySaleStatus =
  | "upcoming"
  | "open"
  | "closed"
  | "move_in_upcoming";

export type NearbySaleCompetition = {
  rate: number;
  label: string;
};

export type NearbySaleCard = {
  /** Dedup key: source + houseManageNo + pblancNo */
  id: string;
  source: NearbySaleSource;
  sourceType: NearbySourceType;
  sourceId: string;
  houseManageNo: string;
  pblancNo: string;
  projectName: string;
  address: string;
  sigungu: string;
  regionLabel: string;
  supplyUnits: number | null;
  supplyUnitsLabel: string | null;
  announcementDate: string | null;
  subscriptionStartDate: string | null;
  subscriptionEndDate: string | null;
  /** YYYYMM. Month precision only — never invent a day. */
  moveInPlannedYm: string | null;
  /** YYYY.MM */
  moveInLabel: string | null;
  currentStatus: NearbySaleStatus;
  statusLabel: string;
  scheduleLabel: string | null;
  competition: NearbySaleCompetition | null;
  pblancUrl: string | null;
};

export type NearbySalesResult = {
  status: NearbySupplySectionStatus;
  message: string;
  sigungu: string | null;
  scope: "SIGUNGU";
  items: NearbySaleCard[];
};

export type ApplyhomeDetailRow = {
  HOUSE_MANAGE_NO?: string | number;
  PBLANC_NO?: string | number;
  HOUSE_NM?: string;
  HOUSE_SECD?: string | number;
  HOUSE_SECD_NM?: string;
  HOUSE_DTL_SECD?: string | number;
  HOUSE_DTL_SECD_NM?: string;
  HSSPLY_ADRES?: string;
  SUBSCRPT_AREA_CODE_NM?: string;
  TOT_SUPLY_HSHLDCO?: string | number;
  RCRIT_PBLANC_DE?: string;
  RCEPT_BGNDE?: string;
  RCEPT_ENDDE?: string;
  SUBSCRPT_RCEPT_BGNDE?: string;
  SUBSCRPT_RCEPT_ENDDE?: string;
  PRZWNER_PRESNATN_DE?: string;
  CNTRCT_CNCLS_BGNDE?: string;
  CNTRCT_CNCLS_ENDDE?: string;
  MVN_PREARNGE_YM?: string;
  PBLANC_URL?: string;
};

export type ApplyhomeCompetitionRow = {
  SUBSCRPT_RANK_CODE?: string | number;
  RESIDE_SECD?: string;
  CMPET_RATE?: string | number;
};

const STATUS_LABEL: Record<NearbySaleStatus, string> = {
  upcoming: "청약 예정",
  open: "청약 중",
  closed: "청약 종료",
  move_in_upcoming: "입주 예정",
};

const EXCLUDED_DETAIL = /상가|생활숙박|지식산업|비주거/;
const RANK_1 = 1;
const RESIDE_LOCAL = "01";
const LAST_DATE = "9999-99-99";
const LAST_YM = "999999";

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseSupplyDate(raw: string | null | undefined): Date | null {
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
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  }
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function formatIsoDate(date: Date | null): string | null {
  if (!date) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function kstToday(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = parts.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function normalizeMoveInYm(ym: string | null | undefined): string | null {
  if (!ym) return null;
  const digits = ym.replace(/[^0-9]/g, "");
  if (digits.length < 6) return null;
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  if (!y || m < 1 || m > 12) return null;
  return `${digits.slice(0, 4)}${digits.slice(4, 6)}`;
}

export function formatMoveInLabel(ym: string | null): string | null {
  if (!ym || ym.length < 6) return null;
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

function currentYm(today: Date): string {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

/** Current month is still in feed. A past YYYYMM is excluded. */
export function isCurrentOrFutureMoveIn(
  ym: string | null,
  today: Date,
): boolean {
  if (!ym) return false;
  return ym >= currentYm(today);
}

function formatScheduleDate(date: Date, today: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (y !== today.getUTCFullYear()) return `${y}.${m}.${d}`;
  return `${m}.${d}`;
}

export function isApartmentRow(row: ApplyhomeDetailRow): boolean {
  const secd = str(row.HOUSE_SECD);
  const name = str(row.HOUSE_SECD_NM);
  const detail = str(row.HOUSE_DTL_SECD_NM);
  if (EXCLUDED_DETAIL.test(detail)) return false;
  if (secd && secd !== "01") return false;
  if (name && name !== "APT") return false;
  return true;
}

export function isResidentialOfficetelRow(row: ApplyhomeDetailRow): boolean {
  const detailCode = str(row.HOUSE_DTL_SECD);
  const detailName = str(row.HOUSE_DTL_SECD_NM);
  if (EXCLUDED_DETAIL.test(detailName)) return false;
  return detailCode === "02" || detailName === "오피스텔";
}

type StatusInput = {
  subscriptionStart: Date | null;
  subscriptionEnd: Date | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  winnerDate: Date | null;
  moveInYm: string | null;
};

/**
 * Subscription window wins over move-in.
 * After the window, a current/future move-in month becomes 입주 예정.
 * Otherwise keep 청약 종료 only while contract/winner is still pending.
 * Past move-in months are excluded.
 */
export function deriveSupplyStatus(
  input: StatusInput,
  today: Date,
): NearbySaleStatus | null {
  const start = input.subscriptionStart;
  const end = input.subscriptionEnd;
  const futureMoveIn = isCurrentOrFutureMoveIn(input.moveInYm, today);

  if (start && today < start) return "upcoming";
  if (start && end && today >= start && today <= end) return "open";
  if (!start && end && today <= end) return "open";
  if (start && !end && today >= start) {
    if (!(input.contractEnd && today > input.contractEnd)) return "open";
  }

  const subscriptionOver = Boolean(end && today > end) || (!start && !end);

  if (subscriptionOver && futureMoveIn) return "move_in_upcoming";

  if (end && today > end && !futureMoveIn) {
    const pending =
      (input.contractEnd && today <= input.contractEnd) ||
      (input.contractStart && today <= input.contractStart) ||
      (input.winnerDate && today <= input.winnerDate) ||
      (input.contractStart &&
        !input.contractEnd &&
        today >= input.contractStart);
    return pending ? "closed" : null;
  }

  if (futureMoveIn) return "move_in_upcoming";
  return null;
}

function scheduleLabelFor(
  status: NearbySaleStatus,
  start: Date | null,
  end: Date | null,
  today: Date,
): string | null {
  if (status === "upcoming" && start) {
    return `청약 ${formatScheduleDate(start, today)}`;
  }
  if (status === "open" && end) return `청약 ~${formatScheduleDate(end, today)}`;
  if (status === "open" && start) return `청약 ${formatScheduleDate(start, today)}`;
  if (status === "closed") return "청약 종료";
  return null;
}

function regionLabel(row: ApplyhomeDetailRow, sigungu: string): string {
  const addr = str(row.HSSPLY_ADRES);
  const dong = addr.match(/([가-힣0-9]+(?:동|가))(?:\s|$)/)?.[1] ?? "";
  if (addr) {
    const match = addr.match(
      /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^\s]*\s*([가-힣]+구|[가-힣]+시|[가-힣]+군)/,
    );
    if (match) {
      const base = `${match[1]} ${match[2]}`;
      return dong ? `${base} ${dong}` : base;
    }
  }
  const area = str(row.SUBSCRPT_AREA_CODE_NM);
  const base = area ? `${area} ${sigungu}` : sigungu;
  return dong ? `${base} ${dong}` : base;
}

function supplyUnitsLabel(
  count: number | null,
  sourceType: NearbySourceType,
): string | null {
  if (count == null || count <= 0) return null;
  const unit = sourceType === "OFFICETEL" ? "실" : "세대";
  return `${count.toLocaleString("ko-KR")}${unit}`;
}

export function canonicalSupplyId(
  source: NearbySaleSource,
  houseManageNo: string,
  pblancNo: string,
): string {
  return `${source}:${houseManageNo}:${pblancNo}`;
}

export function normalizeApplyhomeRow(
  row: ApplyhomeDetailRow,
  sourceType: NearbySourceType,
  sigungu: string,
  today: Date,
): NearbySaleCard | null {
  if (sourceType === "APT" && !isApartmentRow(row)) return null;
  if (sourceType === "OFFICETEL" && !isResidentialOfficetelRow(row)) return null;

  const houseManageNo = str(row.HOUSE_MANAGE_NO);
  const pblancNo = str(row.PBLANC_NO);
  const projectName = str(row.HOUSE_NM);
  if (!houseManageNo || !pblancNo || !projectName) return null;

  const start = parseSupplyDate(
    str(row.RCEPT_BGNDE) || str(row.SUBSCRPT_RCEPT_BGNDE),
  );
  const end = parseSupplyDate(
    str(row.RCEPT_ENDDE) || str(row.SUBSCRPT_RCEPT_ENDDE),
  );
  const contractStart = parseSupplyDate(row.CNTRCT_CNCLS_BGNDE);
  const contractEnd = parseSupplyDate(row.CNTRCT_CNCLS_ENDDE);
  const winnerDate = parseSupplyDate(row.PRZWNER_PRESNATN_DE);
  const moveInPlannedYm = normalizeMoveInYm(row.MVN_PREARNGE_YM);
  const currentStatus = deriveSupplyStatus(
    {
      subscriptionStart: start,
      subscriptionEnd: end,
      contractStart,
      contractEnd,
      winnerDate,
      moveInYm: moveInPlannedYm,
    },
    today,
  );
  if (!currentStatus) return null;

  const source: NearbySaleSource =
    sourceType === "OFFICETEL" ? "applyhome:officetel" : "applyhome:apt";
  const supplyUnits = num(row.TOT_SUPLY_HSHLDCO);

  return {
    id: canonicalSupplyId(source, houseManageNo, pblancNo),
    source,
    sourceType,
    sourceId: `${houseManageNo}:${pblancNo}`,
    houseManageNo,
    pblancNo,
    projectName,
    address: str(row.HSSPLY_ADRES),
    sigungu,
    regionLabel: regionLabel(row, sigungu),
    supplyUnits: supplyUnits != null && supplyUnits > 0 ? supplyUnits : null,
    supplyUnitsLabel: supplyUnitsLabel(supplyUnits, sourceType),
    announcementDate: formatIsoDate(parseSupplyDate(row.RCRIT_PBLANC_DE)),
    subscriptionStartDate: formatIsoDate(start),
    subscriptionEndDate: formatIsoDate(end),
    moveInPlannedYm,
    moveInLabel: formatMoveInLabel(moveInPlannedYm),
    currentStatus,
    statusLabel: STATUS_LABEL[currentStatus],
    scheduleLabel: scheduleLabelFor(currentStatus, start, end, today),
    competition: null,
    pblancUrl: str(row.PBLANC_URL) || null,
  };
}

/** 1순위 해당지역 only. Blank or "-" is absent, not zero. */
export function pickCompetition(
  rows: ApplyhomeCompetitionRow[],
): NearbySaleCompetition | null {
  let best: number | null = null;
  for (const row of rows) {
    const rank = num(row.SUBSCRPT_RANK_CODE);
    const reside = str(row.RESIDE_SECD);
    if (rank !== RANK_1 || reside !== RESIDE_LOCAL) continue;
    const raw = str(row.CMPET_RATE);
    if (!raw || raw === "-") continue;
    const rate = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(rate) || rate < 0) continue;
    if (best == null || rate > best) best = rate;
  }
  if (best == null) return null;
  const rounded = Math.round(best * 100) / 100;
  return {
    rate: rounded,
    label: `1순위 해당지역 ${rounded}:1`,
  };
}

export function dedupeSupplyCards(cards: NearbySaleCard[]): NearbySaleCard[] {
  const seen = new Set<string>();
  const out: NearbySaleCard[] = [];
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    out.push(card);
  }
  return out;
}

function activeSortKey(card: NearbySaleCard): string {
  if (card.currentStatus === "open") {
    return card.subscriptionEndDate || LAST_DATE;
  }
  if (card.currentStatus === "upcoming") {
    return card.subscriptionStartDate || LAST_DATE;
  }
  return LAST_DATE;
}

/**
 * 1. 청약 중 / 청약 예정 — nearest schedule first, unknown last
 * 2. 청약 종료
 * 3. 입주 예정 — move-in month ascending, unknown last
 */
export function sortSupplyCards(cards: NearbySaleCard[]): NearbySaleCard[] {
  const bucket = (status: NearbySaleStatus) => {
    if (status === "open" || status === "upcoming") return 0;
    if (status === "closed") return 1;
    return 2;
  };
  return [...cards].sort((a, b) => {
    const byBucket = bucket(a.currentStatus) - bucket(b.currentStatus);
    if (byBucket !== 0) return byBucket;
    if (a.currentStatus === "move_in_upcoming") {
      const byYm = (a.moveInPlannedYm || LAST_YM).localeCompare(
        b.moveInPlannedYm || LAST_YM,
      );
      if (byYm !== 0) return byYm;
    } else if (bucket(a.currentStatus) === 0) {
      const byDate = activeSortKey(a).localeCompare(activeSortKey(b));
      if (byDate !== 0) return byDate;
    } else {
      const byClosed = (a.subscriptionEndDate || LAST_DATE).localeCompare(
        b.subscriptionEndDate || LAST_DATE,
      );
      if (byClosed !== 0) return byClosed;
    }
    return a.projectName.localeCompare(b.projectName, "ko") || a.id.localeCompare(b.id);
  });
}

export function buildSupplyFeed(
  rows: Array<{ row: ApplyhomeDetailRow; sourceType: NearbySourceType }>,
  sigungu: string,
  today: Date,
): NearbySaleCard[] {
  const cards = rows
    .map(({ row, sourceType }) =>
      normalizeApplyhomeRow(row, sourceType, sigungu, today),
    )
    .filter((card): card is NearbySaleCard => card != null);
  return sortSupplyCards(dedupeSupplyCards(cards));
}
