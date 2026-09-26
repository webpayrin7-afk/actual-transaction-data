/**
 * 공공데이터포털 전국횡단보도표준데이터 (tn_pubr_public_crosswalk_api) — 서버 전용, 읽기만.
 * 횡단보도 위치·보행자 신호등 유무·녹색/적색 신호 시간을 걷기 경로의 횡단 지점에 붙인다.
 * 서비스 키(MOLIT_API_KEY = 공공데이터포털 일반 인증키)에 이 API 활용신청이 되어 있어야 한다 — 안 되어 있으면 빈 목록과 사유를 돌려준다.
 * 응답 필드 이름은 표준데이터 규격을 따르되, 이름이 조금 달라도 읽히게 느슨하게 찾는다.
 */
export type Crosswalk = {
  lat: number;
  lng: number;
  signal: boolean | null;
  greenSec: number | null;
  redSec: number | null;
};

export type CrosswalkLoad = { status: "ok" | "unavailable"; note: string; items: Crosswalk[] };

const cache = new Map<string, { at: number; p: Promise<CrosswalkLoad> }>();
const TTL = 24 * 3600_000;

function pick(o: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(o)) if (re.test(k)) return v;
  return undefined;
}
const numOrNull = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const yn = (v: unknown) => (v === "Y" ? true : v === "N" ? false : null);

async function load(sigungu: string): Promise<CrosswalkLoad> {
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) return { status: "unavailable", note: "공공데이터포털 키 없음", items: [] };
  const enc = key.includes("%") ? key : encodeURIComponent(key);
  const items: Crosswalk[] = [];
  for (let page = 1; page <= 20; page++) {
    const url =
      `https://api.data.go.kr/openapi/tn_pubr_public_crosswalk_api?serviceKey=${enc}&pageNo=${page}&numOfRows=1000&type=json` +
      `&signguNm=${encodeURIComponent(sigungu)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE ERROR/i.test(text)) {
      return { status: "unavailable", note: "전국횡단보도표준데이터 활용신청 필요 (공공데이터포털)", items: [] };
    }
    let body: { response?: { body?: { items?: unknown; totalCount?: number | string } } };
    try {
      body = JSON.parse(text);
    } catch {
      return { status: "unavailable", note: "횡단보도 응답을 읽지 못함", items: [] };
    }
    const raw = body.response?.body?.items;
    const list = (Array.isArray(raw) ? raw : raw && typeof raw === "object" && "item" in raw ? [(raw as { item: unknown }).item].flat() : []) as Array<
      Record<string, unknown>
    >;
    for (const it of list) {
      const lat = numOrNull(pick(it, /^latitude$|lat/i));
      const lng = numOrNull(pick(it, /^longitude$|lon|lng/i));
      if (lat == null || lng == null) continue;
      items.push({
        lat,
        lng,
        signal: yn(pick(it, /pedstrn.*sgnl|sgnl.*(yn|at)$/i)),
        greenSec: numOrNull(pick(it, /grn|green/i)),
        redSec: numOrNull(pick(it, /red/i)),
      });
    }
    const total = Number(body.response?.body?.totalCount ?? 0);
    if (list.length < 1000 || items.length >= total) break;
  }
  return { status: "ok", note: `전국횡단보도표준데이터 ${items.length}곳`, items };
}

/** 시·군·구 이름으로 (예: "송파구") — 같은 이름 구(중구 등)는 부르는 쪽에서 좌표로 거른다. 못 받은 결과는 1시간만 기억 */
export function loadCrosswalks(sigungu: string): Promise<CrosswalkLoad> {
  const k = sigungu;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = load(sigungu).catch(
    (e): CrosswalkLoad => ({ status: "unavailable", note: `횡단보도 데이터 오류: ${e instanceof Error ? e.message : "?"}`, items: [] }),
  );
  cache.set(k, { at: Date.now(), p });
  void p.then((r) => {
    if (r.status !== "ok") cache.set(k, { at: Date.now() - TTL + 3600_000, p });
  });
  return p;
}
