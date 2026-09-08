import { XMLParser } from "fast-xml-parser";

const SEOUL_OPENAPI_BASE = "http://openapi.seoul.go.kr:8088";
const SERVICE_NAME = "dreamMoney";
const PAGE_SIZE = 100;

/** 시중은행·인터넷은행 등 1금융권으로 분류하는 기관명 키워드 */
const FIRST_TIER_KEYWORDS = [
  "국민",
  "신한",
  "우리",
  "하나",
  "농협",
  "기업",
  "산업",
  "수협",
  "SC",
  "씨티",
  "한국씨티",
  "카카오",
  "케이뱅크",
  "토스",
  "아이엠",
  "대구",
  "부산",
  "경남",
  "광주",
  "전북",
  "제주",
] as const;

export interface BankLoanRate {
  orgCode: string;
  orgName: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  loanCount: number;
  minRate: number;
  maxRate: number;
  avgRate: number;
  minSubsidyRate: number;
  maxSubsidyRate: number;
  avgSubsidyRate: number;
  isFirstTier: boolean;
}

export interface DreamMoneyResult {
  items: BankLoanRate[];
  totalCount: number;
  fetchedAt: string;
  source: "seoul-openapi";
  dataset: "OA-21098";
  /** sample 키는 최대 5건만 반환 */
  partial: boolean;
  usingSampleKey: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  isArray: (name) => name === "row",
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function num(value: unknown): number {
  const n = Number(text(value).replaceAll(",", ""));
  return Number.isFinite(n) ? n : 0;
}

function formatYmd(raw: string): string {
  const digits = raw.replaceAll(/\D/g, "");
  if (digits.length !== 8) return raw;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function isFirstTierBank(name: string): boolean {
  return FIRST_TIER_KEYWORDS.some((kw) => name.includes(kw));
}

/**
 * 서울 열린데이터광장 인증키.
 * Vercel/로컬 `SEOUL_OPENAPI_KEY` 사용. 없으면 sample(최대 5건).
 * https://data.seoul.go.kr/together/mypage/actkeyMain.do
 */
function resolveApiKey(): { key: string; usingSampleKey: boolean } {
  // 정적 치환 회피 — 런타임에 Vercel env를 읽음
  const fromEnv = (process.env["SEOUL_OPENAPI_KEY"] ?? "").trim();
  if (fromEnv) {
    const usingSampleKey = fromEnv.toLowerCase() === "sample";
    return { key: fromEnv, usingSampleKey };
  }
  return { key: "sample", usingSampleKey: true };
}

/** INFO-000 정상, INFO-200 데이터 없음. INFO-100 등은 인증/요청 오류. */
function assertSeoulOk(code: string, message: string): void {
  if (code === "INFO-000" || code === "INFO-200") return;
  throw new Error(message || `서울 OpenAPI 오류: ${code}`);
}

interface RawRow {
  lo_org_cd?: string;
  lo_org_nm?: string;
  base_str_dt?: string;
  base_end_dt?: string;
  lo_cnt?: string | number;
  min_lo_ir?: string | number;
  max_lo_ir?: string | number;
  avg_lo_ir?: string | number;
  min_lo_ale_ir?: string | number;
  max_lo_ale_ir?: string | number;
  avg_lo_ale_ir?: string | number;
}

function mapRow(row: RawRow): BankLoanRate {
  const orgName = text(row.lo_org_nm);
  return {
    orgCode: text(row.lo_org_cd),
    orgName,
    periodStart: formatYmd(text(row.base_str_dt)),
    periodEnd: formatYmd(text(row.base_end_dt)),
    loanCount: Math.round(num(row.lo_cnt)),
    minRate: num(row.min_lo_ir),
    maxRate: num(row.max_lo_ir),
    avgRate: num(row.avg_lo_ir),
    minSubsidyRate: num(row.min_lo_ale_ir),
    maxSubsidyRate: num(row.max_lo_ale_ir),
    avgSubsidyRate: num(row.avg_lo_ale_ir),
    isFirstTier: isFirstTierBank(orgName),
  };
}

function parseDreamMoneyXml(xml: string): {
  code: string;
  message: string;
  totalCount: number;
  rows: BankLoanRate[];
} {
  const parsed = parser.parse(xml) as {
    searchLoOrgIrList?: {
      list_total_count?: string | number;
      RESULT?: { CODE?: string; MESSAGE?: string };
      row?: RawRow | RawRow[];
    };
    RESULT?: { CODE?: string; MESSAGE?: string };
  };

  const root = parsed.searchLoOrgIrList;
  const result = root?.RESULT ?? parsed.RESULT;
  const code = text(result?.CODE) || "UNKNOWN";
  const message = text(result?.MESSAGE) || "알 수 없는 응답";
  const totalCount = num(root?.list_total_count);
  const rows = asArray(root?.row).map(mapRow);

  return { code, message, totalCount, rows };
}

async function fetchPage(
  key: string,
  start: number,
  end: number,
): Promise<string> {
  const url = `${SEOUL_OPENAPI_BASE}/${encodeURIComponent(key)}/xml/${SERVICE_NAME}/${start}/${end}/`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/xml" },
  });
  if (!res.ok) {
    throw new Error(`서울 OpenAPI 요청 실패 (${res.status})`);
  }
  return res.text();
}

/**
 * 서울시 은행별 대출금리(시중은행협력자금) — OA-21098 / dreamMoney
 * https://data.seoul.go.kr/dataList/OA-21098/A/1/datasetView.do
 */
export async function fetchDreamMoneyRates(): Promise<DreamMoneyResult> {
  const { key, usingSampleKey } = resolveApiKey();
  const maxEnd = usingSampleKey ? 5 : PAGE_SIZE;

  const firstXml = await fetchPage(key, 1, maxEnd);
  const first = parseDreamMoneyXml(firstXml);
  assertSeoulOk(first.code, first.message);

  const items = [...first.rows];
  const totalCount = first.totalCount || items.length;

  if (!usingSampleKey && items.length < totalCount) {
    for (let start = PAGE_SIZE + 1; start <= totalCount; start += PAGE_SIZE) {
      const end = Math.min(start + PAGE_SIZE - 1, totalCount);
      const xml = await fetchPage(key, start, end);
      const page = parseDreamMoneyXml(xml);
      assertSeoulOk(page.code, page.message);
      items.push(...page.rows);
    }
  }

  items.sort((a, b) => a.minRate - b.minRate || a.orgName.localeCompare(b.orgName, "ko"));

  return {
    items,
    totalCount,
    fetchedAt: new Date().toISOString(),
    source: "seoul-openapi",
    dataset: "OA-21098",
    partial: items.length < totalCount,
    usingSampleKey,
  };
}
