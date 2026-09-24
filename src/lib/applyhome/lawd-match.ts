/**
 * 청약홈 공급위치 주소 → 시군구 코드(lawd 5자리). 이름 정확 일치만 (퍼지 없음).
 * "경기도 성남시 분당구 …" → 41135, "서울 강남구 …" → 11680. 구가 있는 시인데 주소에 구가 없으면
 * 동 이름으로 한 번 더 좁히고(그 시 안에서 그 동이 한 구에만 있을 때), 그래도 애매하면 null.
 */
import { NATIONWIDE_LAWD_ROWS } from "@/lib/constants/nationwide-lawd";

const SIDO_ALIASES: Record<string, string[]> = {
  서울특별시: ["서울", "서울시"],
  부산광역시: ["부산", "부산시"],
  대구광역시: ["대구", "대구시"],
  인천광역시: ["인천", "인천시"],
  광주광역시: ["광주"],
  대전광역시: ["대전", "대전시"],
  울산광역시: ["울산", "울산시"],
  세종특별자치시: ["세종", "세종시"],
  경기도: ["경기"],
  강원특별자치도: ["강원", "강원도"],
  충청북도: ["충북"],
  충청남도: ["충남"],
  전북특별자치도: ["전북", "전라북도"],
  전라남도: ["전남"],
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

export type DongIndex = Map<string, Set<string>>; // "법정동 이름" → lawd codes

/**
 * 주소 문자열 후보: 괄호 안(블록 이름 뒤에 실제 주소를 적는 경우가 많다) → 전체 순.
 * 각 후보에서 첫 시·도 토큰부터 읽는다. "화성특례시"처럼 특례시는 "시"로 본다.
 */
export function matchLawd(address: string | null | undefined, dongIndex?: DongIndex): string | null {
  if (!address) return null;
  const candidates = [...address.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!).concat(address);
  for (const c of candidates) {
    const tokens = c
      .replace(/[(),]/g, " ")
      .trim()
      .split(/\s+/)
      .map((x) => x.replace(/특례시$/, "시"));
    const start = tokens.findIndex((x) => SIDO_OF[x]);
    if (start < 0) continue;
    const hit = matchTokens(tokens.slice(start), dongIndex);
    if (hit) return hit;
  }
  return null;
}

function matchTokens(t: string[], dongIndex?: DongIndex): string | null {
  const sido = SIDO_OF[t[0] ?? ""];
  if (!sido) return null;
  if (sido === "세종특별자치시") return BY_NAME.get(`${sido}|`) ?? null;
  const three = BY_NAME.get(`${sido}|${t[1]} ${t[2]}`);
  if (three) return three;
  const children = CITY_CHILDREN.get(`${sido}|${t[1]}`);
  if (children) {
    // 구가 있는 시인데 주소에 구가 없다 — 다음 토큰(동·읍·면)이 그 시의 한 구에만 있으면 그 구
    const dong = t[2];
    if (!dong || !dongIndex) return null;
    const hits = [...(dongIndex.get(dong) ?? [])].filter((c) => children.includes(c));
    return hits.length === 1 ? hits[0]! : null;
  }
  return BY_NAME.get(`${sido}|${t[1]}`) ?? null;
}
