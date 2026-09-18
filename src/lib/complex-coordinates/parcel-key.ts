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
 * Official 19-digit PNU:
 *   법정동코드 10 (시도2+시군구3+읍면동3+리2)
 *   + 산/대지 구분 1
 *   + 본번 4
 *   + 부번 4
 *
 * plat digit is preserved as stored. This parser does not decide whether
 * "1" means 산 — REB and Building Hub disagree on that digit for the same parcel.
 */
export type ParsedPnu = {
  pnu: string;
  bjdong10: string;
  lawdCd: string;
  bjdongCd: string;
  platGb: "0" | "1";
  bun: string;
  ji: string;
};

export function normalizePnu(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.replace(/\s+/g, "");
  if (!/^\d{19}$/.test(s)) return null;
  return s;
}

export function parsePnu(raw: string | null | undefined): ParsedPnu | null {
  const pnu = normalizePnu(raw);
  if (!pnu) return null;
  const plat = pnu[10];
  if (plat !== "0" && plat !== "1") return null;
  return {
    pnu,
    bjdong10: pnu.slice(0, 10),
    lawdCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGb: plat,
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
  };
}

/**
 * REB 필지고유번호 often uses platGb "1" where Building Hub uses "0".
 * Land-agnostic key is for identity bridge only: lawd(5)+bjd(5)+bun(4)+ji(4).
 * Final spatial join should use the source's full PNU, not this key.
 */
export function pnuLandAgnosticKey(pnu19: string | null | undefined): string | null {
  const parsed = parsePnu(pnu19);
  if (!parsed) return null;
  return parsed.bjdong10 + parsed.bun + parsed.ji;
}

export function buildLandAgnosticParcelKey(
  pnu19: string | null | undefined,
): string | null {
  return pnuLandAgnosticKey(pnu19);
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
