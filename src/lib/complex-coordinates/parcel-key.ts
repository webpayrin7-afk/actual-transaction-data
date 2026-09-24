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
 * plat digit is preserved as stored. It is not rewritten.
 * Building Hub uses 0/1. This Seoul cadastral file uses 1 (일반) and 2 (임야).
 * REB 필지고유번호 matches the cadastral digit (잠실엘스 plat 1). Digit 2 is not coerced to 0.
 */
export type ParsedPnu = {
  pnu: string;
  bjdong10: string;
  lawdCd: string;
  bjdongCd: string;
  /**
   * Digit 11 of the 19-digit PNU, preserved as stored.
   * - "0" / "1": Building Hub platGb (대지/산). Not rewritten.
   * - "1" / "2": continuous-cadastral PNU (일반/임야). Seoul 20260908 file contains only 1 and 2.
   */
  platGb: "0" | "1" | "2";
  bun: string;
  ji: string;
};

export function normalizePnu(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, "");
  if (!/^\d{19}$/.test(s)) return null;
  return s;
}

export function parsePnu(raw: string | null | undefined): ParsedPnu | null {
  const pnu = normalizePnu(raw);
  if (!pnu) return null;
  const plat = pnu[10];
  if (plat !== "0" && plat !== "1" && plat !== "2") return null;
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
 * Official continuous-cadastral PNU for spatial exact join.
 * Accepts plat 1 (일반) and 2 (임야/산) only. Does not remap 2 → 0.
 * Plat 0 is hub encoding and is not a key in the cadastral point file.
 */
export function parseCadastralPnu(raw: string | null | undefined): ParsedPnu | null {
  const parsed = parsePnu(raw);
  if (!parsed || parsed.platGb === "0") return null;
  return parsed;
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

/** True when the address's trailing 본번-부번 equals the PNU lot. Null if either side cannot be parsed. */
export function trailingLotAgreesPnu(
  address: string | null | undefined,
  pnu: string | null | undefined,
): boolean | null {
  const parsed = parsePnu(pnu);
  if (!parsed || !address) return null;
  const m = /(\d+(?:-\d+)?)\s*$/.exec(address.trim());
  if (!m) return null;
  const lot = parseJibun(m[1]);
  if (!lot) return null;
  return lot.bun === parsed.bun && lot.ji === parsed.ji;
}

/**
 * Trailing lot on one REB 주소. "산" counts only as its own token before the lot,
 * not as a syllable inside a dong name. Null when the lot is not explicit.
 */
export function parseSameRowLot(
  address: string | null | undefined,
): { bun: string; ji: string; mountain: boolean } | null {
  if (!address) return null;
  const s = address.trim();
  const mountain = /(?:^|\s)산\s*(\d+)(?:-(\d+))?\s*$/.exec(s);
  if (mountain) {
    const lot = parseJibun(mountain[2] ? `${mountain[1]}-${mountain[2]}` : mountain[1]);
    if (!lot) return null;
    return { bun: lot.bun, ji: lot.ji, mountain: true };
  }
  const plain = /(\d+)(?:-(\d+))?\s*$/.exec(s);
  if (!plain) return null;
  const lot = parseJibun(plain[2] ? `${plain[1]}-${plain[2]}` : plain[1]);
  if (!lot) return null;
  return { bun: lot.bun, ji: lot.ji, mountain: false };
}

export type SameRowRepairCause =
  | "SUBLOT_0000_TO_NONEMPTY"
  | "BUN_MISMATCH"
  | "PLAT_MISMATCH"
  | "OTHER";

/**
 * Rebuild a cadastral PNU from one stored REB PNU plus that same row's 주소.
 * Keeps 법정동 and 산여부. Replaces 본번/부번 only when the address states them.
 * Returns null when the address lot is missing or 산여부 disagrees with the stored digit.
 */
export function deriveSameRowCadastralPnu(
  storedPnu: string | null | undefined,
  address: string | null | undefined,
): { pnu: string; cause: SameRowRepairCause | null } | { pnu: null; cause: "PLAT_MISMATCH" | null } {
  const parsed = parseCadastralPnu(storedPnu);
  const lot = parseSameRowLot(address);
  if (!parsed || !lot) return { pnu: null, cause: null };
  if (lot.mountain !== (parsed.platGb === "2")) return { pnu: null, cause: "PLAT_MISMATCH" };
  const pnu = `${parsed.bjdong10}${parsed.platGb}${lot.bun}${lot.ji}`;
  if (pnu === parsed.pnu) return { pnu, cause: null };
  if (parsed.bun !== lot.bun) return { pnu, cause: "BUN_MISMATCH" };
  if (parsed.ji === "0000" && lot.ji !== "0000") return { pnu, cause: "SUBLOT_0000_TO_NONEMPTY" };
  return { pnu, cause: "OTHER" };
}

/**
 * Same-row diagnostic only. When REB 필지고유번호 부번 is not the address lot,
 * rebuild 19-digit PNU keeping 법정동+산여부 and taking 본번/부번 from that row's 주소.
 * Returns null when the stored lot already agrees or the address cannot be parsed.
 * Not a fuzzy join key.
 */
export function alignedCadastralPnuFromAddress(
  storedPnu: string | null | undefined,
  address: string | null | undefined,
): string | null {
  const parsed = parseCadastralPnu(storedPnu);
  if (!parsed || trailingLotAgreesPnu(address, parsed.pnu) !== false) return null;
  const m = /(\d+(?:-\d+)?)\s*$/.exec((address ?? "").trim());
  if (!m) return null;
  const lot = parseJibun(m[1]);
  if (!lot) return null;
  return `${parsed.bjdong10}${parsed.platGb}${lot.bun}${lot.ji}`;
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
