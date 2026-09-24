/**
 * 오늘의 시장 — 정책·규제 발표.
 * 정부 부처 공식 RSS(키 불필요)에서 제목·링크·날짜만 읽고, 주거·대출 관련 항목만 남긴다.
 * 본문은 저장·표시하지 않는다(원문 링크로 이동).
 */
import { unstable_cache } from "next/cache";

/** 피드 캐시 수명(초). 라우트 revalidate와 맞춘다. */
export const POLICY_NEWS_REVALIDATE_SECONDS = 1800;
/** 표시 범위 — 최근 N일 발표 */
const WINDOW_DAYS = 14;
const MAX_ITEMS = 20;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 2_000_000;

export type PolicySourceKey = "molit" | "fsc" | "mofe";

type FeedDef = {
  key: PolicySourceKey;
  /** 기관명 (목록 표시) */
  label: string;
  /** 짧은 이름 (탭·태그) */
  short: string;
  url: string;
  /** 원문 목록 페이지 */
  listUrl: string;
  /** 링크 허용 호스트 (피드가 준 링크만 그대로 쓰되, 외부 호스트는 버린다) */
  hosts: string[];
};

/** 확인된 공식 RSS (2026-09-24 응답 확인). korea.kr /rss/*.xml 은 폐지(404). */
export const POLICY_FEEDS: readonly FeedDef[] = [
  {
    key: "molit",
    label: "국토교통부",
    short: "국토부",
    url: "https://www.molit.go.kr/dev/board/board_rss.jsp?rss_id=NEWS",
    listUrl: "https://www.molit.go.kr/USR/NEWS/m_71/lst.jsp",
    hosts: ["www.molit.go.kr", "molit.go.kr"],
  },
  {
    key: "fsc",
    label: "금융위원회",
    short: "금융위",
    url: "https://www.fsc.go.kr/about/fsc_bbs_rss/?fid=0111",
    listUrl: "https://www.fsc.go.kr/no010101",
    hosts: ["www.fsc.go.kr", "fsc.go.kr"],
  },
  {
    key: "mofe",
    label: "재정경제부",
    short: "재경부",
    url: "https://www.mofe.go.kr/com/detailRssTagService.do?bbsId=MOSFBBS_000000000028",
    listUrl: "https://www.mofe.go.kr/nw/nes/nesdta.do?bbsId=MOSFBBS_000000000028&menuNo=4010100",
    hosts: ["www.mofe.go.kr", "mofe.go.kr", "www.moef.go.kr", "moef.go.kr"],
  },
];

/**
 * 제목 키워드 — 주거·부동산·주택금융.
 * '공급'은 '공급망' 같은 다른 뜻이 많아 주택 문맥과 붙은 경우만 본다.
 */
const TOPIC_PATTERN = new RegExp(
  [
    "부동산",
    "주택",
    "아파트",
    "청약",
    "분양",
    "대출",
    "가계부채",
    "주담대",
    "DSR",
    "LTV",
    "DTI",
    "전세",
    "전월세",
    "월세",
    "임대차",
    "임대주택",
    "재건축",
    "재개발",
    "정비사업",
    "택지",
    "신도시",
    "토지거래허가",
    "규제지역",
    "조정대상",
    "투기과열",
    "종부세",
    "종합부동산세",
    "양도세",
    "양도소득세",
    "취득세",
    "보유세",
    "공시가격",
    "공시지가",
    "실거래",
    "집값",
    "주거",
    "부동산\\s*PF",
    "PF\\s*대출",
  ].join("|"),
  "i",
);

export type PolicyNewsItem = {
  id: string;
  title: string;
  url: string;
  source: PolicySourceKey;
  sourceLabel: string;
  /** ISO (UTC) */
  publishedAt: string;
};

export type PolicySourceStatus = {
  key: PolicySourceKey;
  label: string;
  short: string;
  listUrl: string;
  ok: boolean;
  /** 관련 항목 수 (필터 후) */
  count: number;
};

export type PolicyNewsResponse = {
  items: PolicyNewsItem[];
  sources: PolicySourceStatus[];
  windowDays: number;
  fetchedAt: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent.toLowerCase()] ?? m;
  });
}

function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  else v = decodeEntities(v);
  return v;
}

function cleanTitle(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** RFC 822, 또는 시간대 없는 "YYYY-MM-DD HH:mm:ss(.0)" (한국시간) */
function parseFeedDate(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;
  const local = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (local && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = local;
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function safeLink(raw: string, feed: FeedDef): string | null {
  const v = decodeEntities(raw.trim());
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!feed.hosts.includes(u.hostname.toLowerCase())) return null;
  // 세 기관 모두 https 제공 — 혼합 콘텐츠·다운그레이드 방지
  u.protocol = "https:";
  return u.toString();
}

export function parseFeed(xml: string, feed: FeedDef): PolicyNewsItem[] {
  const out: PolicyNewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const title = cleanTitle(tagText(block, "title"));
    const url = safeLink(tagText(block, "link"), feed);
    const date =
      parseFeedDate(tagText(block, "pubDate")) ?? parseFeedDate(tagText(block, "dc:date"));
    if (!title || !url || !date) continue;
    out.push({
      id: `${feed.key}:${url}`,
      title,
      url,
      source: feed.key,
      sourceLabel: feed.label,
      publishedAt: date.toISOString(),
    });
  }
  return out;
}

export function isHousingRelated(title: string): boolean {
  if (/공급망/.test(title) && !/주택|아파트|부동산/.test(title)) return false;
  return TOPIC_PATTERN.test(title) || /주택\s*공급|공급\s*대책/.test(title);
}

function collectCookies(res: Response, jar: Map<string, string>) {
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;=\s]+=)/);
  for (const c of list) {
    const pair = c.split(";")[0]?.trim();
    if (!pair) continue;
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

/**
 * 국토부 RSS는 첫 요청에 쿠키를 심고 같은 주소로 307을 돌려준다.
 * 수동 리다이렉트로 쿠키를 붙여 다시 요청한다(최대 3회, 같은 호스트만).
 */
async function fetchFeedText(feed: FeedDef): Promise<string> {
  const jar = new Map<string, string>();
  let url = feed.url;
  for (let hop = 0; hop < 4; hop += 1) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ZIPLAB/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400) {
      collectCookies(res, jar);
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`${feed.key}: redirect without location`);
      const next = new URL(loc, url);
      if (!feed.hosts.includes(next.hostname.toLowerCase())) {
        throw new Error(`${feed.key}: redirect to foreign host`);
      }
      url = next.toString();
      continue;
    }
    if (!res.ok) throw new Error(`${feed.key}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error(`${feed.key}: body too large`);
    if (!/<rss[\s>]|<channel[\s>]/i.test(text)) throw new Error(`${feed.key}: not RSS`);
    return text;
  }
  throw new Error(`${feed.key}: too many redirects`);
}

/** 기관별 캐시 — 실패는 throw 해서 캐시에 남기지 않는다. */
const cachedFeed = unstable_cache(
  async (key: PolicySourceKey): Promise<PolicyNewsItem[]> => {
    const feed = POLICY_FEEDS.find((f) => f.key === key);
    if (!feed) return [];
    const xml = await fetchFeedText(feed);
    return parseFeed(xml, feed);
  },
  ["market-policy-feed-v1"],
  { revalidate: POLICY_NEWS_REVALIDATE_SECONDS, tags: ["market-policy-news"] },
);

export async function getPolicyNews(now: Date = new Date()): Promise<PolicyNewsResponse> {
  const since = now.getTime() - WINDOW_DAYS * 86_400_000;
  const results = await Promise.all(
    POLICY_FEEDS.map(async (feed) => {
      try {
        const all = await cachedFeed(feed.key);
        const items = all.filter(
          (i) => isHousingRelated(i.title) && new Date(i.publishedAt).getTime() >= since,
        );
        return { feed, ok: true, items };
      } catch (error) {
        console.warn(`[market-news] ${feed.key} feed failed:`, error);
        return { feed, ok: false, items: [] as PolicyNewsItem[] };
      }
    }),
  );

  const seen = new Set<string>();
  const items = results
    .flatMap((r) => r.items)
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, MAX_ITEMS);

  return {
    items,
    sources: results.map((r) => ({
      key: r.feed.key,
      label: r.feed.label,
      short: r.feed.short,
      listUrl: r.feed.listUrl,
      ok: r.ok,
      count: r.items.length,
    })),
    windowDays: WINDOW_DAYS,
    fetchedAt: now.toISOString(),
  };
}
