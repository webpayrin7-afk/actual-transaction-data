/**
 * 시장 홈 — 부동산 뉴스 헤드라인 (NAVER API HUB 뉴스 검색).
 * 제목·언론사·시각·링크만 쓴다. 기사 요약(description)·본문은 저장·표시하지 않는다.
 * 키: NAVER_API_HUB_CLIENT_ID / NAVER_API_HUB_CLIENT_SECRET (지역 검색과 같은 서버 전용 키).
 */
import { cleanNaverLocalTitle, getNaverLocalSearchCredentials } from "@/lib/complex-detail/naver-local-search";

const NEWS_ENDPOINT = "https://naverapihub.apigw.ntruss.com/search/v1/news";
export const HEADLINES_REVALIDATE_SECONDS = 900;
/** 최근 N시간 기사만 */
const WINDOW_HOURS = 48;
const PER_TOPIC = 10;

/**
 * 제목에 주거 문맥이 있어야 한다. 정책 발표 필터보다 좁다 — 뉴스는 "카드론 금리" 같은
 * 주거와 무관한 대출 기사가 많아 맨 "대출"은 인정하지 않는다.
 */
const HOUSING_TITLE =
  /부동산|주택|아파트|청약|분양|주담대|DSR|LTV|전세|월세|임대차|재건축|재개발|정비사업|신도시|토지거래허가|규제지역|조정대상|투기과열|종부세|양도세|취득세|보유세|공시가격|실거래|집값|매매가|입주|오피스텔|빌라|갭투자|영끌|내\s?집/;
const FETCH_TIMEOUT_MS = 8000;

export type HeadlineTopic = "policy" | "trade" | "jeonse" | "loan";

/** 주제별 검색어 — 검색 결과는 최신순. */
const TOPICS: ReadonlyArray<{ key: HeadlineTopic; label: string; query: string }> = [
  { key: "policy", label: "정책", query: "부동산 대책" },
  { key: "trade", label: "매매", query: "아파트 매매" },
  { key: "jeonse", label: "전월세", query: "전세 시장" },
  { key: "loan", label: "대출", query: "주택담보대출" },
];

export type HeadlineItem = {
  id: string;
  title: string;
  url: string;
  press: string;
  topic: HeadlineTopic;
  /** ISO (UTC) */
  publishedAt: string;
};

export type HeadlinesResponse =
  | {
      status: "ok";
      topics: Array<{ key: HeadlineTopic; label: string; count: number; ok: boolean }>;
      items: HeadlineItem[];
      windowHours: number;
      fetchedAt: string;
    }
  | { status: "unconfigured" };

/** 주요 언론사 도메인 → 이름. 없으면 도메인을 그대로 보인다. */
const PRESS: Record<string, string> = {
  "yna.co.kr": "연합뉴스",
  "yonhapnewstv.co.kr": "연합뉴스TV",
  "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제",
  "chosun.com": "조선일보",
  "biz.chosun.com": "조선비즈",
  "joongang.co.kr": "중앙일보",
  "donga.com": "동아일보",
  "hani.co.kr": "한겨레",
  "khan.co.kr": "경향신문",
  "sedaily.com": "서울경제",
  "edaily.co.kr": "이데일리",
  "mt.co.kr": "머니투데이",
  "news1.kr": "뉴스1",
  "newsis.com": "뉴시스",
  "fnnews.com": "파이낸셜뉴스",
  "heraldcorp.com": "헤럴드경제",
  "asiae.co.kr": "아시아경제",
  "hankookilbo.com": "한국일보",
  "seoul.co.kr": "서울신문",
  "kmib.co.kr": "국민일보",
  "munhwa.com": "문화일보",
  "segye.com": "세계일보",
  "etoday.co.kr": "이투데이",
  "newspim.com": "뉴스핌",
  "dailian.co.kr": "데일리안",
  "ajunews.com": "아주경제",
  "bizwatch.co.kr": "비즈워치",
  "sbs.co.kr": "SBS",
  "kbs.co.kr": "KBS",
  "imbc.com": "MBC",
  "ytn.co.kr": "YTN",
  "jtbc.co.kr": "JTBC",
  "mbn.co.kr": "MBN",
  "tvchosun.com": "TV조선",
  "ichannela.com": "채널A",
  "nocutnews.co.kr": "노컷뉴스",
  "ohmynews.com": "오마이뉴스",
  "pressian.com": "프레시안",
  "inews24.com": "아이뉴스24",
  "zdnet.co.kr": "지디넷코리아",
  "businesspost.co.kr": "비즈니스포스트",
  "thebell.co.kr": "더벨",
  "nspna.com": "NSP통신",
  "wowtv.co.kr": "한국경제TV",
  "sentv.co.kr": "서울경제TV",
};

function pressOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|news|n)\./, "");
    if (PRESS[host]) return PRESS[host]!;
    const parts = host.split(".");
    for (let i = 1; i < parts.length - 1; i += 1) {
      const tail = parts.slice(i).join(".");
      if (PRESS[tail]) return PRESS[tail]!;
    }
    return host;
  } catch {
    return "";
  }
}

type RawItem = { title?: string; originallink?: string; link?: string; pubDate?: string };

async function fetchTopic(
  topic: (typeof TOPICS)[number],
  creds: { clientId: string; clientSecret: string },
): Promise<HeadlineItem[]> {
  const url = `${NEWS_ENDPOINT}?${new URLSearchParams({
    query: topic.query,
    display: "100",
    sort: "date",
  })}`;
  const res = await fetch(url, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": creds.clientId,
      "X-NCP-APIGW-API-KEY": creds.clientSecret,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    next: { revalidate: HEADLINES_REVALIDATE_SECONDS, tags: ["market-headlines"] },
  });
  if (!res.ok) throw new Error(`news ${topic.key}: HTTP ${res.status}`);
  const body = (await res.json()) as { items?: RawItem[] };
  const out: HeadlineItem[] = [];
  for (const it of body.items ?? []) {
    const title = cleanNaverLocalTitle(it.title ?? "");
    const original = it.originallink?.trim() || "";
    const naver = it.link?.trim() || "";
    // 네이버 뉴스에 실린 기사(제휴 언론사)만 — 품질 필터이자 모바일에서 안정적인 링크.
    if (!/^https:\/\/n\.news\.naver\.com\//.test(naver)) continue;
    if (!HOUSING_TITLE.test(title)) continue;
    const href = naver;
    const when = it.pubDate ? new Date(it.pubDate) : null;
    if (!title || !/^https?:\/\//.test(href) || !when || Number.isNaN(when.getTime())) continue;
    out.push({
      id: original || href,
      title,
      url: href,
      press: pressOf(original || href),
      topic: topic.key,
      publishedAt: when.toISOString(),
    });
  }
  return out;
}

export async function getHousingHeadlines(now: Date = new Date()): Promise<HeadlinesResponse> {
  const creds = getNaverLocalSearchCredentials();
  if (!creds) return { status: "unconfigured" };
  const since = now.getTime() - WINDOW_HOURS * 3_600_000;

  const results = await Promise.all(
    TOPICS.map(async (t) => {
      try {
        const items = (await fetchTopic(t, creds)).filter(
          (i) => new Date(i.publishedAt).getTime() >= since,
        );
        return { topic: t, ok: true, items };
      } catch (error) {
        console.warn("[market-headlines]", t.key, error);
        return { topic: t, ok: false, items: [] as HeadlineItem[] };
      }
    }),
  );

  // 같은 기사(원문 주소)나 같은 제목은 먼저 나온 주제 하나에만 둔다.
  const seenId = new Set<string>();
  const seenTitle = new Set<string>();
  const perTopic = results.map((r) => {
    const kept: HeadlineItem[] = [];
    for (const i of r.items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      const tkey = i.title.replace(/\s+/g, "");
      if (seenId.has(i.id) || seenTitle.has(tkey)) continue;
      seenId.add(i.id);
      seenTitle.add(tkey);
      kept.push(i);
      if (kept.length >= PER_TOPIC) break;
    }
    return { ...r, items: kept };
  });

  return {
    status: "ok",
    topics: perTopic.map((r) => ({
      key: r.topic.key,
      label: r.topic.label,
      count: r.items.length,
      ok: r.ok,
    })),
    items: perTopic
      .flatMap((r) => r.items)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    windowHours: WINDOW_HOURS,
    fetchedAt: now.toISOString(),
  };
}
