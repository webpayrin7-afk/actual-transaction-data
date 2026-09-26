import type { MetadataRoute } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  "https://actual-transaction-data.vercel.app";

/**
 * AI 학습·수집 봇은 사이트 전체를 막는다 (집랩 데이터·계산 결과를 베껴 가지 못하게).
 * 일반 검색엔진은 페이지만 허용하고 데이터 API(/api/)는 막는다.
 */
const AI_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "Claude-SearchBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "GoogleOther",
  "PerplexityBot",
  "Perplexity-User",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
  "meta-externalagent",
  "Meta-ExternalFetcher",
  "FacebookBot",
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "YouBot",
  "Omgilibot",
  "Omgili",
  "ImagesiftBot",
  "Timpibot",
  "AI2Bot",
  "Ai2Bot-Dolma",
  "DuckAssistBot",
  "PetalBot",
  "Scrapy",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: AI_BOTS, disallow: "/" },
      { userAgent: "*", allow: "/", disallow: "/api/" },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
