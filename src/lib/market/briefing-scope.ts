import { METRO_LABELS, metroFromLawdNationwide, type NationwideMetro } from "@/lib/constants/nationwide-lawd";
import type { MarketHomeResponse, MarketLocalList } from "@/lib/market/home";

/**
 * 지도 브리핑 '이 지역' 거르기 — /api/market-home 목록(전국 앞 몇 개 + local.extra)을 브라우저에서 시·도 / 구로 거른다.
 * 새 조회 없음. 개수는 local.counts(LAWD별 전체)가 있으면 그것으로, 없으면(예전 스냅샷) 받은 목록 길이로 센다.
 */

/** 지도 가운데 지역 — /api/map/region-at */
export type MapRegionAt = { lawdCd: string; name: string; metro: NationwideMetro; metroLabel: string };

export type BriefScope =
  | { kind: "all"; label: "전국" }
  | { kind: "metro"; metro: NationwideMetro; label: string }
  | { kind: "gu"; metro: NationwideMetro; lawdCd: string; guName: string; label: string };

type Located = { lawdCd?: string; gu: string; href: string };

export type BriefListKey = "singoga" | "drops" | "volumeSurges";
export const BRIEF_LIST_KEYS: BriefListKey[] = ["singoga", "drops", "volumeSurges"];

function isMetro(v: string): v is NationwideMetro {
  return v in METRO_LABELS;
}

/** 항목의 시·도 — LAWD가 있으면 그것으로, 없으면 단지 링크의 지역(seoul-*, gyeonggi-*, busan-26110 …) */
export function itemMetro(item: Located): NationwideMetro | null {
  if (item.lawdCd) return metroFromLawdNationwide(item.lawdCd);
  try {
    const slug = new URL(item.href, "http://x").searchParams.get("region") ?? "";
    const head = slug.split("-")[0] ?? "";
    return isMetro(head) ? head : null;
  } catch {
    return null;
  }
}

/** 같은 구인가 — LAWD가 같거나, 같은 시·도에서 구 이름이 같다(수원시 영통구 ↔ 영통구, 광주·전남 코드 개편) */
function itemInGu(item: Located, scope: { metro: NationwideMetro; lawdCd: string; guName: string }): boolean {
  if (item.lawdCd && item.lawdCd === scope.lawdCd) return true;
  if (itemMetro(item) !== scope.metro) return false;
  const gu = item.gu.trim();
  return gu !== "" && (gu === scope.guName || gu.endsWith(` ${scope.guName}`));
}

export function inScope(item: Located, scope: BriefScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "metro") return itemMetro(item) === scope.metro;
  return itemInGu(item, scope);
}

function localOf(data: MarketHomeResponse, key: BriefListKey): MarketLocalList<Located> | undefined {
  return data.local?.[key] as MarketLocalList<Located> | undefined;
}

/** 이 범위의 목록 — 전국 목록(전체 순서) 다음 보충 목록(역시 전체 순서). 앞 `max`개 */
export function scopedList<K extends BriefListKey>(
  data: MarketHomeResponse,
  key: K,
  scope: BriefScope,
  max: number,
): MarketHomeResponse[K] {
  const main = data[key] as Located[];
  if (scope.kind === "all") return main.slice(0, max) as MarketHomeResponse[K];
  const extra = localOf(data, key)?.extra ?? [];
  return [...main, ...extra].filter((i) => inScope(i, scope)).slice(0, max) as MarketHomeResponse[K];
}

const NATION_COUNT: Record<BriefListKey, (d: MarketHomeResponse) => number> = {
  singoga: (d) => d.kpis.singogaCount,
  drops: (d) => d.kpis.dropCount,
  volumeSurges: (d) => d.kpis.volumeSurgeCount ?? 0,
};

/** 이 범위의 개수 */
export function scopedCount(data: MarketHomeResponse, key: BriefListKey, scope: BriefScope): number {
  if (scope.kind === "all") return NATION_COUNT[key](data);
  const local = localOf(data, key);
  if (local) {
    if (scope.kind === "gu") {
      const exact = local.counts[scope.lawdCd];
      if (exact != null) return exact;
    } else {
      let n = 0;
      for (const [lawd, c] of Object.entries(local.counts)) if (metroFromLawdNationwide(lawd) === scope.metro) n += c;
      return n;
    }
  }
  // 예전 스냅샷·코드 불일치 — 받은 목록으로 센다
  const main = data[key] as Located[];
  const extra = local?.extra ?? [];
  const seen = new Set<Located>();
  for (const i of [...main, ...extra]) if (inScope(i, scope)) seen.add(i);
  return seen.size;
}

export function scopeTotal(data: MarketHomeResponse, scope: BriefScope): number {
  return BRIEF_LIST_KEYS.reduce((s, k) => s + scopedCount(data, k, scope), 0);
}

/**
 * 가운데 지역 + 줌 → 범위. 구 수준으로 확대했고 그 구에 오늘 항목이 있으면 구, 아니면 시·도.
 * region 이 없으면(찾는 중·못 찾음) null.
 */
export function localScope(
  data: MarketHomeResponse | undefined,
  region: MapRegionAt | null,
  zoomedIn: boolean,
): BriefScope | null {
  if (!region || region.metro === "other") return null;
  const metro: BriefScope = { kind: "metro", metro: region.metro, label: region.metroLabel };
  if (!zoomedIn || !data) return metro;
  const gu: BriefScope = { kind: "gu", metro: region.metro, lawdCd: region.lawdCd, guName: region.name, label: region.name };
  return scopeTotal(data, gu) > 0 ? gu : metro;
}

/** 받침 있으면 '은', 없으면 '는' (서울은 · 경기는 · 송파구는) */
export function topicJosa(word: string): string {
  const ch = word.trim().at(-1);
  if (!ch) return "는";
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return "는";
  return code % 28 === 0 ? "는" : "은";
}
