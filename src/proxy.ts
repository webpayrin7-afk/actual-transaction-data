import { NextResponse, type NextRequest } from "next/server";

/**
 * 데이터 API 보호 — 집랩 화면에서 부른 요청만 받는다 (다른 사이트·스크립트·AI 수집기가 데이터를 통째로 가져가지 못하게).
 *  1) AI·스크래퍼 봇 User-Agent와 빈 User-Agent는 거부
 *  2) 브라우저가 붙이는 출처 표시(Sec-Fetch-Site, Origin/Referer)가 우리 사이트일 때만 허용
 *  3) 같은 IP가 짧은 시간에 너무 많이 부르면 잠시 거부 (인스턴스별 가벼운 제한 — 강한 제한은 Vercel 방화벽에서)
 * 운영용 예외: 개발 서버, Vercel 보호 우회 헤더가 붙은 프리뷰 점검, 관리 비밀값이 붙은 요청.
 */

const BOT_UA =
  /(gptbot|chatgpt|oai-searchbot|claudebot|claude-web|anthropic|ccbot|google-extended|googleother|perplexity|bytespider|amazonbot|applebot-extended|meta-external|facebookbot|cohere|diffbot|youbot|omgili|imagesift|timpibot|ai2bot|duckassist|petalbot|scrapy|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|wget|curl\/|node-fetch|axios|undici|headless|phantomjs|puppeteer|playwright|selenium)/i;

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 240;
const hits = new Map<string, { start: number; n: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now - cur.start > WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    }
    return false;
  }
  cur.n += 1;
  return cur.n > MAX_PER_WINDOW;
}

function sameSite(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "same-site") return true;
  const host = request.headers.get("host");
  for (const h of ["origin", "referer"]) {
    const v = request.headers.get(h);
    if (!v || !host) continue;
    try {
      if (new URL(v).host === host) return true;
    } catch {
      /* 잘못된 헤더는 무시 */
    }
  }
  return false;
}

function deny(status: number, message: string) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return NextResponse.next();
  // 프리뷰 점검(vercel curl)·관리 요청
  // 값이 Vercel 보호 우회 비밀값과 같을 때만 (실서비스엔 보호가 없어 Vercel이 검사하지 않으므로 여기서 직접 비교)
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  const given =
    request.headers.get("x-vercel-protection-bypass") ?? request.nextUrl.searchParams.get("x-vercel-protection-bypass");
  if (bypass && given === bypass) return NextResponse.next();
  const adminSecret = process.env.SYNC_ADMIN_SECRET?.trim();
  if (adminSecret && request.nextUrl.searchParams.get("secret") === adminSecret) return NextResponse.next();

  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || BOT_UA.test(ua)) return deny(403, "허용되지 않은 요청입니다.");
  if (!sameSite(request)) return deny(403, "집랩 화면에서만 사용할 수 있습니다.");

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  if (rateLimited(ip)) return deny(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
