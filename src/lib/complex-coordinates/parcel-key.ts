/**
 * Deterministic parcel / jibun key helpers for public-source joins.
 * Does not invent mountain(산) flags when unknown.
 */

export type JibunParts = {
  bun: string; // 4-digit zero-padded
  ji: string; // 4-digit zero-padded
};

/** Parse "19", "19-0", "128-10" → bun/ji. Rejects non-numeric forms. */
export function parseJibun(jibun: string | null | undefined): JibunParts | null {
  if (!jibun) return null;
  const s = jibun.trim().replace(/\s+/g, "");
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return null;
  const bun = m[1];
  const ji = m[2] ?? "0";
  if (bun.length > 4 || ji.length > 4) return null;
  return {
    bun: bun.padStart(4, "0"),
    ji: ji.padStart(4, "0"),
  };
}

/**
 * Build 19-digit PNU.
 * platGb: building-registry style ("0"=대지, "1"=산) OR null if unknown.
 * When platGb is null, returns null (no invention).
 */
export function buildPnu(params: {
  lawdCd: string | null | undefined; // 5-digit sigungu
  bjdongCd: string | null | undefined; // 5-digit dong
  platGb: "0" | "1" | null;
  bun: string;
  ji: string;
}): string | null {
  const lawd = (params.lawdCd ?? "").trim();
  const bjd = (params.bjdongCd ?? "").trim();
  if (!/^\d{5}$/.test(lawd) || !/^\d{5}$/.test(bjd)) return null;
  if (params.platGb !== "0" && params.platGb !== "1") return null;
  if (!/^\d{4}$/.test(params.bun) || !/^\d{4}$/.test(params.ji)) return null;
  return `${lawd}${bjd}${params.platGb}${params.bun}${params.ji}`;
}

/**
 * REB 필지고유번호 often uses platGb "1" for 대지 while Building Hub uses "0".
 * Normalize both to a land/mountain-agnostic join key: lawd(5)+bjd(5)+bun(4)+ji(4).
 */
export function pnuLandAgnosticKey(pnu19: string | null | undefined): string | null {
  const p = (pnu19 ?? "").trim();
  if (!/^\d{19}$/.test(p)) return null;
  return p.slice(0, 10) + p.slice(11);
}

export function normalizeRoadAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  let s = addr.trim();
  if (!s) return null;
  s = s.replace(/^서울특별시(?=\s|$)/, "서울");
  s = s.replace(/\s+/g, " ").trim();
  // drop parenthetical complex suffixes often appended to road addresses
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return s || null;
}

/** Deterministic road key: strip leading 서울/구 so REB short roads match full CSV roads. */
export function roadAddressJoinKey(addr: string | null | undefined): string | null {
  const n = normalizeRoadAddress(addr);
  if (!n) return null;
  let s = n.replace(/^서울\s+/, "");
  s = s.replace(/^\S+구\s+/, "");
  return s.trim() || null;
}

export function normalizeJibunAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  let s = addr.trim();
  if (!s) return null;
  s = s.replace(/^서울특별시(?=\s|$)/, "서울");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // strip trailing complex name tokens after bunji (best-effort deterministic)
  s = s.replace(/(\d+(?:-\d+)?)\s+\S+$/u, "$1").trim();
  return s || null;
}

export function composeJibunAddress(parts: {
  sido?: string | null;
  sigungu?: string | null;
  dong?: string | null;
  jibun?: string | null;
}): string | null {
  const sigungu = parts.sigungu?.trim();
  const dong = parts.dong?.trim();
  const jibun = parts.jibun?.trim();
  if (!sigungu || !dong || !jibun) return null;
  const sido = (parts.sido ?? "서울특별시").includes("서울")
    ? "서울특별시"
    : (parts.sido ?? "").trim() || "서울특별시";
  return normalizeJibunAddress(`${sido} ${sigungu} ${dong} ${jibun}`);
}

export function isValidWgs84(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Loose Seoul bbox sanity (not a confirmation gate). */
export function inSeoulBbox(lat: number, lng: number): boolean {
  return lat >= 37.42 && lat <= 37.72 && lng >= 126.75 && lng <= 127.22;
}
