/**
 * 청약홈 공급위치 주소 → 시군구 코드(lawd 5자리). 이름 정확 일치만 (퍼지 없음).
 * "경기도 성남시 분당구 …" → 41135, "서울 강남구 …" → 11680. 구가 있는 시인데 주소에 구가 없으면
 * 동 이름으로 한 번 더 좁히고(그 시 안에서 그 동이 한 구에만 있을 때), 그래도 애매하면 null.
 * 청약홈 주소는 분할 전 인천 구 이름(중구·동구·서구)을 아직 쓴다 — 이어받은 새 구가 하나면 그 구,
 * 둘이면 동 이름으로 좁힌다(같은 규칙). keepLegacy 면 좁히지 못할 때 예전 구 코드를 돌려준다.
 */
import { NATIONWIDE_LAWD_ROWS } from "@/lib/constants/nationwide-lawd";
import { LEGACY_REGION_SLUGS } from "@/lib/constants/regions-registry";

const SIDO_ALIASES: Record<string, string[]> = {
  서울특별시: ["서울", "서울시"],
  부산광역시: ["부산", "부산시"],
  대구광역시: ["대구", "대구시"],
  인천광역시: ["인천", "인천시"],
  대전광역시: ["대전", "대전시"],
  울산광역시: ["울산", "울산시"],
  세종특별자치시: ["세종", "세종시"],
  경기도: ["경기"],
  강원특별자치도: ["강원", "강원도"],
  충청북도: ["충북"],
  충청남도: ["충남"],
  전북특별자치도: ["전북", "전라북도"],
  // 2026 광주·전남 통합 — 주소는 옛 이름으로 오는 경우가 많다
  전남광주통합특별시: ["광주광역시", "광주", "전라남도", "전남", "전남광주"],
  경상북도: ["경북"],
  경상남도: ["경남"],
  제주특별자치도: ["제주", "제주도"],
};

const SIDO_OF: Record<string, string> = {};
for (const [full, aliases] of Object.entries(SIDO_ALIASES)) {
  SIDO_OF[full] = full;
  for (const a of aliases) SIDO_OF[a] = full;
}

/** "sido|rest" → codes. rest = "성남시 분당구" | "시흥시" | "" (세종) */
const BY_NAME = new Map<string, string>();
/** "sido|성남시" → 그 시의 구 코드들 */
const CITY_CHILDREN = new Map<string, string[]>();
for (const r of NATIONWIDE_LAWD_ROWS) {
  const [sido, ...rest] = r.fullName.split(/\s+/);
  const fullSido = SIDO_OF[sido!] ?? sido!;
  BY_NAME.set(`${fullSido}|${rest.join(" ")}`, r.code);
  if (rest.length === 2) {
    const k = `${fullSido}|${rest[0]}`;
    CITY_CHILDREN.set(k, [...(CITY_CHILDREN.get(k) ?? []), r.code]);
  }
}

/** 분할 전 인천 구 코드 → 이어받은 새 구 코드 (LEGACY_REGION_SLUGS 와 같은 표) */
export const LEGACY_LAWD_SUCCESSORS: Record<string, string[]> = Object.fromEntries(
  Object.entries(LEGACY_REGION_SLUGS).map(([slug, targets]) => [
    slug.replace(/^incheon-/, ""),
    targets.map((t) => t.replace(/^incheon-/, "")),
  ]),
);

/** "sido|예전 구 이름" → 예전 구 코드 */
const LEGACY_BY_NAME = new Map<string, string>([
  ["인천광역시|중구", "28110"],
  ["인천광역시|동구", "28140"],
  ["인천광역시|서구", "28260"],
]);

/** 새 구 코드 → 그 구가 이어받은 예전 구 코드들 (28125 → 28110·28140) */
export function legacyLawdCodesOf(code: string): string[] {
  return Object.entries(LEGACY_LAWD_SUCCESSORS)
    .filter(([, next]) => next.includes(code))
    .map(([legacy]) => legacy);
}

/** 새 구 코드 → 청약홈 주소에 아직 남은 예전 구 이름 (28290 → 서구) */
export function legacyLawdNamesOf(code: string): string[] {
  const codes = legacyLawdCodesOf(code);
  return [...LEGACY_BY_NAME]
    .filter(([, legacy]) => codes.includes(legacy))
    .map(([key]) => key.split("|")[1]!);
}

/**
 * 동 이름으로 좁힐 때 필요한 코드 범위 — codes 가 속한 시의 구 전부 + 분할된 인천 구의 형제 구.
 * 이 범위의 법정동만 담은 DongIndex 로도 matchLawd 결과가 codes 안에서는 전체 색인과 같다.
 */
export function dongScopeCodes(codes: string[]): string[] {
  const out = new Set(codes);
  for (const children of CITY_CHILDREN.values()) {
    if (children.some((c) => out.has(c))) children.forEach((c) => out.add(c));
  }
  for (const next of Object.values(LEGACY_LAWD_SUCCESSORS)) {
    if (next.some((c) => codes.includes(c))) next.forEach((c) => out.add(c));
  }
  return [...out];
}

export type DongIndex = Map<string, Set<string>>; // "법정동 이름" → lawd codes

/**
 * 주소 문자열 후보: 괄호 안(블록 이름 뒤에 실제 주소를 적는 경우가 많다) → 전체 순.
 * 각 후보에서 첫 시·도 토큰부터 읽는다. "화성특례시"처럼 특례시는 "시"로 본다.
 */
export function matchLawd(
  address: string | null | undefined,
  dongIndex?: DongIndex,
  opts: { keepLegacy?: boolean } = {},
): string | null {
  if (!address) return null;
  const candidates = [...address.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!).concat(address);
  let legacy: string | null = null;
  for (const c of candidates) {
    const tokens = c
      .replace(/[(),]/g, " ")
      .trim()
      .split(/\s+/)
      .map((x) => x.replace(/특례시$/, "시"));
    const start = tokens.findIndex((x) => SIDO_OF[x]);
    if (start < 0) continue;
    const hit = matchTokens(tokens.slice(start), dongIndex);
    if (hit?.legacy) legacy ??= hit.code;
    else if (hit) return hit.code;
  }
  return opts.keepLegacy ? legacy : null;
}

type TokenHit = { code: string; legacy?: boolean };

function narrowByDong(codes: string[], dong: string | undefined, dongIndex?: DongIndex): string | null {
  if (!dong || !dongIndex) return null;
  const hits = [...(dongIndex.get(dong) ?? [])].filter((c) => codes.includes(c));
  return hits.length === 1 ? hits[0]! : null;
}

function matchTokens(t: string[], dongIndex?: DongIndex): TokenHit | null {
  const sido = SIDO_OF[t[0] ?? ""];
  if (!sido) return null;
  const exact = (code: string | null | undefined): TokenHit | null => (code ? { code } : null);
  if (sido === "세종특별자치시") return exact(BY_NAME.get(`${sido}|`));
  const three = BY_NAME.get(`${sido}|${t[1]} ${t[2]}`);
  if (three) return { code: three };
  const children = CITY_CHILDREN.get(`${sido}|${t[1]}`);
  if (children) {
    // 구가 있는 시인데 주소에 구가 없다 — 다음 토큰(동·읍·면)이 그 시의 한 구에만 있으면 그 구
    return exact(narrowByDong(children, t[2], dongIndex));
  }
  const direct = BY_NAME.get(`${sido}|${t[1]}`);
  if (direct) return { code: direct };
  const old = LEGACY_BY_NAME.get(`${sido}|${t[1]}`);
  if (!old) return null;
  // 분할 전 인천 구 — 새 구가 하나면 그 구, 아니면 동 이름으로 (못 좁히면 예전 구 코드 표시).
  // "서구 검단신도시 AA32BL(마전동)"처럼 동이 뒤에 오기도 해서 구 뒤 토큰을 다 본다 — 가리키는 새 구가 하나일 때만.
  const next = LEGACY_LAWD_SUCCESSORS[old] ?? [];
  if (next.length === 1) return { code: next[0]! };
  const hits = new Set<string>();
  for (const tok of t.slice(2)) {
    for (const c of dongIndex?.get(tok) ?? []) if (next.includes(c)) hits.add(c);
  }
  return hits.size === 1 ? { code: [...hits][0]! } : { code: old, legacy: true };
}
